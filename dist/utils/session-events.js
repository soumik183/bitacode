/**
 * session-events.ts — opt-in, append-only event log with snapshots and claims.
 *
 * The regular session store (`<dataDir>/sessions/<id>.json`) stays untouched.
 * This module adds three independent files under `<dataDir>/events/`:
 *
 *   <sessionId>.jsonl          one JSON event per line, never rewritten
 *   <sessionId>.snapshot.json  atomically replaced compacted state
 *   claims.json                sessionId -> { owner, claimedAt } for crash recovery
 *
 * Writers never throw: every failure is returned as an `EventResult` and logged.
 * Appends to one session are serialized through an in-process promise queue so
 * concurrent callers cannot hand out the same `seq`. Readers skip torn or
 * malformed lines, which is what a crash in the middle of an append leaves
 * behind. Paths are built only from strictly validated identifiers, so no
 * caller can escape the events directory.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const EVENT_TYPES = new Set([
    'user',
    'assistant',
    'tool_call',
    'tool_result',
    'compaction',
    'note',
]);
/** One queue per locked resource (an event file or the claims file). */
const locks = new Map();
function ok(value) {
    return { ok: true, value };
}
function fail(error) {
    return { ok: false, error };
}
function errorMessage(error, fallback) {
    if (error instanceof Error && error.message.trim())
        return error.message.trim();
    if (typeof error === 'string' && error.trim())
        return error.trim();
    return fallback;
}
function debug(message, context) {
    try {
        logger.debug(message, context);
    }
    catch {
        // Logging is best-effort; it must never break the event log.
    }
}
function logError(message, context) {
    try {
        logger.error(message, context);
    }
    catch {
        // Logging is best-effort; callers still receive the error result.
    }
}
function validId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value);
}
function isNotFound(error) {
    return typeof error === 'object' && error !== null
        && error.code === 'ENOENT';
}
/** Defensive copy of arbitrary JSON-ish data, with a JSON fallback. */
function copy(value) {
    try {
        return structuredClone(value);
    }
    catch {
        try {
            return JSON.parse(JSON.stringify(value));
        }
        catch {
            return value;
        }
    }
}
function defaultBaseDir() {
    const configured = process.env.XDG_DATA_HOME?.trim();
    return configured || path.join(os.homedir(), '.local', 'share');
}
function resolveDataDir(options) {
    let provided = '';
    try {
        const candidate = options?.dataDir;
        if (typeof candidate === 'string' && candidate.trim())
            provided = candidate.trim();
    }
    catch {
        // A hostile options object falls back to the default location.
    }
    // `dataDir` is the complete application data directory (the default already
    // ends in `bitacode`), so a caller-provided value is used verbatim.
    return provided || path.join(defaultBaseDir(), 'bitacode');
}
/** Directory holding the events, snapshots and claims files. */
export function eventsDir(options) {
    return path.join(resolveDataDir(options ?? undefined), 'events');
}
function eventFile(sessionId, options) {
    return path.join(eventsDir(options), `${sessionId}.jsonl`);
}
function snapshotFile(sessionId, options) {
    return path.join(eventsDir(options), `${sessionId}.snapshot.json`);
}
function claimsFile(options) {
    return path.join(eventsDir(options), 'claims.json');
}
async function ensureEventsDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
        await fs.chmod(dir, 0o700);
    }
    catch {
        // Best effort: an existing directory may be owned by someone else.
    }
}
/** Write to a sibling temp file and rename it into place, so readers see all or nothing. */
async function atomicWrite(target, contents) {
    await ensureEventsDir(path.dirname(target));
    const temp = path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temp, contents, { mode: 0o600 });
        try {
            await fs.chmod(temp, 0o600);
        }
        catch {
            // Best effort; the mode was already requested at creation time.
        }
        await fs.rename(temp, target);
    }
    catch (error) {
        try {
            await fs.rm(temp, { force: true });
        }
        catch {
            // Nothing else to clean up.
        }
        throw error;
    }
}
/** Run `task` after any earlier task on the same key has settled. */
function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const settled = current.then(() => undefined, () => undefined);
    locks.set(key, settled);
    const release = () => {
        if (locks.get(key) === settled)
            locks.delete(key);
    };
    void current.then(release, release);
    return current;
}
function asEvent(value, expectedSessionId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0)
        return null;
    if (!validId(record.sessionId))
        return null;
    if (expectedSessionId !== undefined && record.sessionId !== expectedSessionId)
        return null;
    if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type))
        return null;
    if (typeof record.at !== 'string' || !record.at)
        return null;
    if (!Object.hasOwn(record, 'data'))
        return null;
    return {
        seq: record.seq,
        sessionId: record.sessionId,
        type: record.type,
        at: record.at,
        data: copy(record.data),
    };
}
/** Parse a JSONL buffer, skipping blank, torn and structurally invalid lines. */
function parseEvents(raw, sessionId) {
    const events = [];
    for (const text of raw.split('\n')) {
        const line = text.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            debug('session-events: skipping torn event line', { sessionId });
            continue;
        }
        const event = asEvent(parsed, sessionId);
        if (!event) {
            debug('session-events: skipping malformed event line', { sessionId });
            continue;
        }
        events.push(event);
    }
    return events;
}
async function readRawEvents(sessionId, options) {
    try {
        return await fs.readFile(eventFile(sessionId, options), 'utf8');
    }
    catch (error) {
        if (isNotFound(error))
            return '';
        throw error;
    }
}
/**
 * Append one event. `seq` is allocated from the largest valid sequence number
 * in the file, under a per-session lock, so concurrent appends stay unique and
 * a torn final line never causes valid history to be overwritten.
 */
export async function appendEvent(event, options) {
    try {
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
            return fail('Invalid event: expected an event object.');
        }
        const { sessionId, type, at, data } = event;
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
            return fail('Invalid event type: expected user, assistant, tool_call, tool_result, compaction or note.');
        }
        if (at !== undefined && (typeof at !== 'string' || !at.trim())) {
            return fail('Invalid event time: at must be a non-empty ISO timestamp string.');
        }
        return await withLock(`append:${sessionId}`, async () => {
            const dir = eventsDir(options);
            await ensureEventsDir(dir);
            const target = eventFile(sessionId, options);
            const raw = await readRawEvents(sessionId, options);
            let nextSeq = 1;
            for (const previous of parseEvents(raw, sessionId)) {
                if (previous.seq >= nextSeq)
                    nextSeq = previous.seq + 1;
            }
            const stored = {
                seq: nextSeq,
                sessionId,
                type: type,
                at: at ?? new Date().toISOString(),
                data: copy(data),
            };
            const line = `${JSON.stringify(stored)}\n`;
            if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
                return fail(`Event exceeds the ${MAX_EVENT_BYTES}-byte size limit.`);
            }
            await fs.appendFile(target, line, { mode: 0o600 });
            try {
                await fs.chmod(target, 0o600);
            }
            catch {
                // Best effort: the file was already created with mode 0600.
            }
            return ok(copy(stored));
        });
    }
    catch (error) {
        logError('session-events: failed to append event', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to append event: ${errorMessage(error, 'unknown error')}`);
    }
}
/**
 * Read the events of a session in ascending `seq` order. `after` is exclusive.
 * Missing files are an empty log; malformed lines are skipped and logged.
 */
export async function readEvents(sessionId, options) {
    try {
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        const after = options?.after;
        if (after !== undefined && (typeof after !== 'number' || !Number.isFinite(after))) {
            return fail('Invalid after: expected a finite number.');
        }
        const raw = await readRawEvents(sessionId, options);
        const events = parseEvents(raw, sessionId)
            .filter((event) => after === undefined || event.seq > after)
            .sort((left, right) => left.seq - right.seq)
            .map((event) => ({ ...event, data: copy(event.data) }));
        return ok(events);
    }
    catch (error) {
        logError('session-events: failed to read events', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to read events: ${errorMessage(error, 'unknown error')}`);
    }
}
/** Atomically replace a session's snapshot. */
export async function writeSnapshot(sessionId, snapshot, options) {
    try {
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        const payload = JSON.stringify(snapshot);
        if (payload === undefined) {
            return fail('Invalid snapshot: value is not JSON-serializable.');
        }
        await atomicWrite(snapshotFile(sessionId, options), `${payload}\n`);
        return ok(undefined);
    }
    catch (error) {
        logError('session-events: failed to write snapshot', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to write snapshot: ${errorMessage(error, 'unknown error')}`);
    }
}
/**
 * Read a snapshot. A missing file is `{ ok: true, value: undefined }`; a file
 * that cannot be read or parsed is an error rather than silent data loss.
 */
export async function readSnapshot(sessionId, options) {
    try {
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        let raw;
        try {
            raw = await fs.readFile(snapshotFile(sessionId, options), 'utf8');
        }
        catch (error) {
            if (isNotFound(error))
                return ok(undefined);
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`Corrupt snapshot: ${errorMessage(error, 'invalid JSON')}`);
        }
        return ok(copy(parsed));
    }
    catch (error) {
        logError('session-events: failed to read snapshot', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to read snapshot: ${errorMessage(error, 'unknown error')}`);
    }
}
async function readClaims(options) {
    let raw;
    try {
        raw = await fs.readFile(claimsFile(options), 'utf8');
    }
    catch (error) {
        if (isNotFound(error))
            return ok({});
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Corrupt claims file: ${errorMessage(error, 'invalid JSON')}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Corrupt claims file: expected an object.');
    }
    const claims = {};
    for (const [id, value] of Object.entries(parsed)) {
        if (!validId(id) || !value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const record = value;
        if (!validId(record.owner) || typeof record.claimedAt !== 'string')
            continue;
        claims[id] = { owner: record.owner, claimedAt: record.claimedAt };
    }
    return ok(claims);
}
async function writeClaims(claims, options) {
    await atomicWrite(claimsFile(options), `${JSON.stringify(claims, null, 2)}\n`);
    return ok(undefined);
}
function claimsLockKey(options) {
    return `claims:${claimsFile(options)}`;
}
/**
 * Claim a session for `owner`. Re-claiming by the same owner is idempotent and
 * keeps the original `claimedAt`; a different live owner is a conflict.
 */
export async function claimExecution(sessionId, owner, options) {
    try {
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        if (!validId(owner)) {
            return fail(`Invalid owner: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        return await withLock(claimsLockKey(options), async () => {
            const loaded = await readClaims(options);
            if (!loaded.ok)
                return fail(loaded.error);
            const existing = loaded.value[sessionId];
            if (existing) {
                if (existing.owner === owner)
                    return ok(undefined);
                return fail(`Session "${sessionId}" is already claimed by owner "${existing.owner}".`);
            }
            loaded.value[sessionId] = { owner, claimedAt: new Date().toISOString() };
            return await writeClaims(loaded.value, options);
        });
    }
    catch (error) {
        logError('session-events: failed to claim session', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to claim session: ${errorMessage(error, 'unknown error')}`);
    }
}
/** Release a claim, but only when `owner` matches the recorded owner. */
export async function releaseExecution(sessionId, owner, options) {
    try {
        if (!validId(sessionId)) {
            return fail(`Invalid sessionId: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        if (!validId(owner)) {
            return fail(`Invalid owner: expected 1-80 characters matching ${ID_PATTERN.source}.`);
        }
        return await withLock(claimsLockKey(options), async () => {
            const loaded = await readClaims(options);
            if (!loaded.ok)
                return fail(loaded.error);
            const existing = loaded.value[sessionId];
            if (!existing)
                return ok(undefined);
            if (existing.owner !== owner) {
                return fail(`Session "${sessionId}" is claimed by owner "${existing.owner}", not "${owner}".`);
            }
            delete loaded.value[sessionId];
            return await writeClaims(loaded.value, options);
        });
    }
    catch (error) {
        logError('session-events: failed to release session', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to release session: ${errorMessage(error, 'unknown error')}`);
    }
}
/** All live claims in claim order, as defensive copies. */
export async function claimedSessions(options) {
    try {
        const loaded = await readClaims(options);
        if (!loaded.ok)
            return fail(loaded.error);
        return ok(Object.entries(loaded.value).map(([sessionId, claim]) => ({
            sessionId,
            owner: claim.owner,
            claimedAt: claim.claimedAt,
        })));
    }
    catch (error) {
        logError('session-events: failed to list claims', { error: errorMessage(error, 'unknown error') });
        return fail(`Failed to list claims: ${errorMessage(error, 'unknown error')}`);
    }
}

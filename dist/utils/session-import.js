/**
 * Session import — read-only validation plus a safe copy of a session file.
 *
 * Importing never mutates the source. The JSON is parsed and sanitised in
 * memory first: the message list must exist and stay within hard caps, UI-only
 * message fields are dropped, and unsafe ids are discarded so a foreign file
 * can never choose a filename. The destination is always created atomically
 * with 0600 permissions and an existing session is never overwritten.
 *
 * All functions return an `ImportResult`; they never throw.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isValidSessionId } from '../sessions.js';
import { isUiOnlyMessageField } from './message-sanitize.js';
import { logger } from './logger.js';
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGES = 100_000;
const MAX_TITLE_LENGTH = 200;
const MAX_STRING_FIELD_LENGTH = 200;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// Control characters are not meaningful in titles or route strings.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ALL_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
function failure(error) {
    return { ok: false, error };
}
function describe(error, fallback) {
    if (error instanceof Error && error.message)
        return error.message;
    return fallback;
}
function logError(action, error, fallback) {
    const message = describe(error, fallback);
    try {
        logger.error(`Session import: ${action} failed: ${message}`);
    }
    catch {
        // Logging must never turn a returned error into a thrown one.
    }
    return message;
}
function harden(target, mode) {
    if (process.platform === 'win32')
        return;
    try {
        fs.chmodSync(target, mode);
    }
    catch (err) {
        try {
            logger.warn(`Session import: could not tighten permissions on ${target}: ${err}`);
        }
        catch {
            // Best effort only.
        }
    }
}
function resolveSessionsDir(supplied) {
    if (typeof supplied === 'string' && supplied.trim().length > 0) {
        return path.resolve(supplied);
    }
    const home = os.homedir();
    return process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'bitacode', 'sessions')
        : path.join(home, '.local', 'share', 'bitacode', 'sessions');
}
/** True for an id that tries to address a file path rather than a session. */
function looksLikePath(value) {
    return value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\u0000');
}
function sanitizeSessionId(value) {
    if (typeof value !== 'string')
        return undefined;
    const candidate = value.trim();
    // isValidSessionId accepts only UUID/8-char alphanumeric ids: no separators,
    // no dots, so path traversal ("../evil", "a/b", "C:\\x") is rejected here.
    if (!isValidSessionId(candidate))
        return undefined;
    return candidate;
}
function sanitizeTitle(value) {
    if (typeof value !== 'string')
        return undefined;
    const cleaned = value
        .replace(ALL_CONTROL_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_LENGTH);
    return cleaned || undefined;
}
function sanitizeStringField(value, fallback = '') {
    if (typeof value !== 'string')
        return fallback;
    const cleaned = value.replace(CONTROL_CHARS, '').trim().slice(0, MAX_STRING_FIELD_LENGTH);
    return cleaned || fallback;
}
/** Remove UI-only message keys without mutating the parsed source. */
function cleanMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
        return message;
    const clean = {};
    for (const [key, value] of Object.entries(message)) {
        if (key === '__proto__')
            continue;
        if (isUiOnlyMessageField(key))
            continue;
        clean[key] = value;
    }
    return clean;
}
/** Parse and sanitise session JSON. Shared by validation and import. */
function parseSessionJson(text) {
    try {
        if (typeof text !== 'string')
            return failure('Session JSON must be a string');
        if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
            return failure('Session JSON exceeds the 50MB size limit');
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (err) {
            return failure(`Invalid session JSON: ${describe(err, 'unparseable input')}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return failure('Session JSON must contain an object');
        }
        const source = parsed;
        const rawMessages = source.completionMessages;
        if (!Array.isArray(rawMessages)) {
            return failure('Session JSON must contain a completionMessages array');
        }
        if (rawMessages.length > MAX_MESSAGES) {
            return failure(`Session JSON exceeds the ${MAX_MESSAGES}-message limit`);
        }
        const messages = rawMessages.map(cleanMessage);
        const id = sanitizeSessionId(source.id);
        const title = sanitizeTitle(source.title);
        const session = {};
        for (const [key, value] of Object.entries(source)) {
            if (key === '__proto__')
                continue;
            if (key === 'id' || key === 'title' || key === 'completionMessages')
                continue;
            session[key] = value;
        }
        session.completionMessages = messages;
        session.title = title ?? 'Imported session';
        session.provider = sanitizeStringField(source.provider);
        session.model = sanitizeStringField(source.model);
        const meta = {
            ...(id ? { id } : {}),
            ...(title ? { title } : {}),
            messageCount: messages.length,
        };
        const unsafeId = typeof source.id === 'string' && looksLikePath(source.id);
        if (unsafeId) {
            try {
                logger.warn('Session import: discarded an unsafe session id');
            }
            catch {
                // Best effort.
            }
        }
        return { ok: true, value: { meta, session, unsafeId } };
    }
    catch (err) {
        return { ok: false, error: logError('validation', err, 'Unable to validate session JSON') };
    }
}
/**
 * Validate session JSON without writing anything. UI-only fields are ignored.
 * A path-traversal id is a hard validation error; other malformed ids are
 * simply omitted so an importer can replace them with a generated id.
 */
export function validateSessionJson(text) {
    const parsed = parseSessionJson(text);
    if (!parsed.ok)
        return parsed;
    if (parsed.value.unsafeId) {
        return failure('Unsafe session id: path traversal is not allowed');
    }
    return { ok: true, value: parsed.value.meta };
}
function generateSessionId() {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    let id = '';
    for (let i = 0; i < 8; i++)
        id += alphabet.charAt(crypto.randomInt(alphabet.length));
    return id;
}
function freeGeneratedId(sessionsDir) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = generateSessionId();
        if (!fs.existsSync(path.join(sessionsDir, `${candidate}.json`)))
            return candidate;
    }
    return generateSessionId();
}
function canLink() {
    return process.platform !== 'win32';
}
/** Atomically create `target`, failing if it already exists. */
function createExclusive(target, payload) {
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE });
        if (canLink()) {
            try {
                fs.linkSync(temp, target);
                fs.unlinkSync(temp);
                return;
            }
            catch (err) {
                const code = err.code;
                if (code === 'EEXIST')
                    throw err;
                if (code !== 'EPERM' && code !== 'EXDEV' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') {
                    throw err;
                }
                // Filesystem without hard links: fall back to a guarded rename.
            }
        }
        if (fs.existsSync(target)) {
            const err = new Error(`Destination already exists: ${target}`);
            err.code = 'EEXIST';
            throw err;
        }
        fs.renameSync(temp, target);
    }
    finally {
        fs.rmSync(temp, { force: true });
    }
}
/**
 * Validate a session file and copy it into `sessionsDir` under a safe id.
 * The source is only read; an invalid `newId` (or a missing/unsafe id in the
 * file) is replaced with a freshly generated 8-character alphanumeric id.
 */
export function importSessionFile(sourcePath, options) {
    try {
        if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
            return failure('A source session file path is required');
        }
        let stats;
        try {
            // lstat rejects symlinks too: the source must itself be a regular file.
            stats = fs.lstatSync(sourcePath);
        }
        catch (err) {
            return { ok: false, error: logError('source stat', err, 'Unable to stat the source file') };
        }
        if (!stats.isFile())
            return failure('Source path must be a regular file');
        if (stats.size > MAX_SOURCE_BYTES) {
            return failure('Source session file exceeds the 50MB size limit');
        }
        let text;
        try {
            text = fs.readFileSync(sourcePath, 'utf8');
        }
        catch (err) {
            return { ok: false, error: logError('source read', err, 'Unable to read the source file') };
        }
        const parsed = parseSessionJson(text);
        if (!parsed.ok)
            return parsed;
        const sessionsDir = resolveSessionsDir(options?.sessionsDir);
        const requested = typeof options?.newId === 'string'
            ? sanitizeSessionId(options.newId)
            : undefined;
        const id = requested ?? parsed.value.meta.id ?? freeGeneratedId(sessionsDir);
        if (!isValidSessionId(id))
            return failure(`Invalid destination session id: ${id}`);
        const target = path.join(sessionsDir, `${id}.json`);
        if (path.dirname(path.resolve(target)) !== path.resolve(sessionsDir)) {
            return failure('Resolved session path escapes the sessions directory');
        }
        if (fs.existsSync(target))
            return failure(`Session already exists: ${id}`);
        fs.mkdirSync(sessionsDir, { recursive: true, mode: DIR_MODE });
        harden(sessionsDir, DIR_MODE);
        const session = { ...parsed.value.session, id };
        try {
            createExclusive(target, JSON.stringify(session, null, 2));
        }
        catch (err) {
            return { ok: false, error: logError('destination write', err, 'Unable to write the imported session') };
        }
        harden(target, FILE_MODE);
        return { ok: true, value: { id, path: target } };
    }
    catch (err) {
        return { ok: false, error: logError('import', err, 'Unable to import the session file') };
    }
}

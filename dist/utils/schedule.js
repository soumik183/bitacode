/**
 * schedule.ts — local scheduled / recurring prompt persistence.
 *
 * Mirrors the shape of OpenCode v2's automation jobs (`core/src/automation/job.ts`):
 * a task owns a prompt, an interval and the timestamp of its next run. This
 * module is deliberately only the persistence + due-calculation layer: it does
 * not start timers and never executes a prompt. A caller (e.g. a `/schedule`
 * CLI command) owns those responsibilities.
 *
 * Tasks live at `<dataDir>/bitacode/schedule.json`, where `dataDir` defaults to
 * `$XDG_DATA_HOME || ~/.local/share`. The store is written atomically (unique
 * temp file + rename) with a 0700 directory and a 0600 file. Every public
 * function is best-effort: failures become `{ ok: false, error }` results and
 * are never thrown into a caller. Values crossing the boundary are defensive
 * copies, so mutating a returned task cannot change the stored state.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_TASKS = 100;
const MAX_PROMPT_CHARS = 4_000;
const MAX_ID_CHARS = 128;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 2_592_000_000; // 30 days
// C0/C1 controls except tab (09), LF (0A) and CR (0D); CR is normalized to LF.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const UNIT_MS = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};
function ok(value) {
    return { ok: true, value };
}
function fail(error) {
    return { ok: false, error };
}
/** Short, single-line message for an unknown thrown value. */
function errorMessage(error) {
    const raw = error instanceof Error ? error.message : String(error);
    const text = raw || 'unknown error';
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
function isMissing(error) {
    return Boolean(error) && error.code === 'ENOENT';
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isValidInterval(value) {
    return isFiniteNumber(value)
        && Number.isInteger(value)
        && value >= MIN_INTERVAL_MS
        && value <= MAX_INTERVAL_MS;
}
function defaultDataDir() {
    const configured = process.env.XDG_DATA_HOME;
    if (typeof configured === 'string' && configured.trim())
        return configured.trim();
    try {
        return path.join(os.homedir(), '.local', 'share');
    }
    catch {
        return path.join(process.cwd(), '.local', 'share');
    }
}
function resolveNow(options) {
    const candidate = options?.now;
    return isFiniteNumber(candidate) ? candidate : Date.now();
}
/** Strip control characters, normalize newlines and bound the prompt length. */
function sanitizePrompt(value) {
    if (typeof value !== 'string')
        return undefined;
    const cleaned = value
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARS, '')
        .trim();
    if (cleaned.length < 1 || cleaned.length > MAX_PROMPT_CHARS)
        return undefined;
    return cleaned;
}
/** Ids are only compared as map keys, but keep them printable and bounded. */
function sanitizeId(value) {
    if (typeof value !== 'string')
        return undefined;
    const id = value.replace(CONTROL_CHARS, '').trim();
    if (!id || id.length > MAX_ID_CHARS)
        return undefined;
    return id;
}
function copyTask(task) {
    const copy = {
        id: task.id,
        prompt: task.prompt,
        intervalMs: task.intervalMs,
        nextRunAt: task.nextRunAt,
        createdAt: task.createdAt,
        enabled: task.enabled,
    };
    if (task.lastRunAt !== undefined)
        copy.lastRunAt = task.lastRunAt;
    return copy;
}
/** Rebuild a task field by field; a malformed record is rejected, not repaired. */
function sanitizeTask(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    const id = sanitizeId(raw.id);
    const prompt = sanitizePrompt(raw.prompt);
    if (!id || !prompt || !isValidInterval(raw.intervalMs))
        return undefined;
    if (!isFiniteNumber(raw.nextRunAt) || !isFiniteNumber(raw.createdAt))
        return undefined;
    if (typeof raw.enabled !== 'boolean')
        return undefined;
    const task = {
        id,
        prompt,
        intervalMs: raw.intervalMs,
        nextRunAt: raw.nextRunAt,
        createdAt: raw.createdAt,
        enabled: raw.enabled,
    };
    if (isFiniteNumber(raw.lastRunAt))
        task.lastRunAt = raw.lastRunAt;
    return task;
}
/** Short, random, URL-safe id (12 hex chars from a UUID). */
function makeId() {
    try {
        return randomUUID().replace(/-/g, '').slice(0, 12);
    }
    catch {
        return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
}
/** Absolute path of the schedule store; never throws. */
export function scheduleStorePath(options) {
    try {
        const explicit = options?.dataDir;
        const base = typeof explicit === 'string' && explicit.trim() ? explicit : defaultDataDir();
        return path.join(base, 'bitacode', 'schedule.json');
    }
    catch (err) {
        logger.warn('Schedule: could not resolve store path', { err: errorMessage(err) });
        return path.join(defaultDataDir(), 'bitacode', 'schedule.json');
    }
}
/**
 * Parse a human interval such as `30s`, `15m`, `2h` or `1d` (case-insensitive).
 * Values outside 10s..30d are rejected. Never throws.
 */
export function parseInterval(value) {
    try {
        if (typeof value !== 'string')
            return undefined;
        const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
        if (!match)
            return undefined;
        const amount = Number(match[1]);
        if (!Number.isSafeInteger(amount))
            return undefined;
        const ms = amount * UNIT_MS[match[2].toLowerCase()];
        return isValidInterval(ms) ? ms : undefined;
    }
    catch {
        return undefined;
    }
}
/** Read and fully validate the store. A missing file is an empty schedule. */
async function readSchedule(filePath) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    }
    catch (err) {
        if (isMissing(err))
            return ok([]);
        logger.warn('Schedule: could not read store', { err: errorMessage(err) });
        return fail(`Could not read schedule: ${errorMessage(err)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        logger.warn('Schedule: store is not valid JSON');
        return fail('Could not parse schedule: corrupt JSON');
    }
    if (!Array.isArray(parsed))
        return fail('Could not parse schedule: expected an array');
    if (parsed.length > MAX_TASKS)
        return fail(`Could not parse schedule: more than ${MAX_TASKS} tasks`);
    const tasks = [];
    const seen = new Set();
    for (const entry of parsed) {
        const task = sanitizeTask(entry);
        if (!task || seen.has(task.id))
            return fail('Could not parse schedule: invalid task entry');
        seen.add(task.id);
        tasks.push(task);
    }
    return ok(tasks);
}
/** Write a fresh snapshot to a temp file in the same directory, then rename. */
async function persistTasks(filePath, tasks) {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
        await fs.chmod(dir, DIR_MODE).catch(() => undefined);
        const payload = `${JSON.stringify(tasks.map(copyTask), null, 2)}\n`;
        const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: FILE_MODE });
            await fs.chmod(tempPath, FILE_MODE).catch(() => undefined);
            await fs.rename(tempPath, filePath);
        }
        catch (err) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw err;
        }
        return ok(undefined);
    }
    catch (err) {
        logger.warn('Schedule: could not save store', { err: errorMessage(err) });
        return fail(`Could not save schedule: ${errorMessage(err)}`);
    }
}
/** Serialize load-modify-write operations so parallel calls cannot lose tasks. */
let writeChain = Promise.resolve();
function serialize(operation) {
    const result = writeChain.then(operation, operation);
    writeChain = result.then(() => undefined, () => undefined);
    return result;
}
/** Load the schedule; returns defensive copies. Missing store means empty. */
export async function loadSchedule(options) {
    try {
        return await readSchedule(scheduleStorePath(options));
    }
    catch (err) {
        logger.warn('Schedule: could not load store', { err: errorMessage(err) });
        return fail(`Could not load schedule: ${errorMessage(err)}`);
    }
}
/** Replace the whole store with a validated snapshot (at most 100 tasks). */
export async function saveSchedule(tasks, options) {
    return serialize(async () => {
        try {
            if (!Array.isArray(tasks))
                return fail('Invalid schedule: expected an array of tasks');
            if (tasks.length > MAX_TASKS)
                return fail(`Schedule is full (${MAX_TASKS} tasks maximum)`);
            const cleaned = [];
            const seen = new Set();
            for (const entry of tasks) {
                const task = sanitizeTask(entry);
                if (!task || seen.has(task.id))
                    return fail('Invalid schedule: malformed or duplicate task');
                seen.add(task.id);
                cleaned.push(task);
            }
            return await persistTasks(scheduleStorePath(options), cleaned);
        }
        catch (err) {
            logger.warn('Schedule: could not save schedule', { err: errorMessage(err) });
            return fail(`Could not save schedule: ${errorMessage(err)}`);
        }
    });
}
/** Add a validated task due at `now + intervalMs`. A corrupt store is never overwritten. */
export async function addSchedule(prompt, intervalMs, options) {
    return serialize(async () => {
        try {
            const cleanPrompt = sanitizePrompt(prompt);
            if (cleanPrompt === undefined) {
                return fail(`Invalid prompt: must be 1..${MAX_PROMPT_CHARS} characters`);
            }
            if (!isValidInterval(intervalMs)) {
                return fail(`Invalid interval: must be ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} ms`);
            }
            const filePath = scheduleStorePath(options);
            const loaded = await readSchedule(filePath);
            if (!loaded.ok)
                return fail(`Cannot add schedule: ${loaded.error}`);
            if (loaded.value.length >= MAX_TASKS)
                return fail(`Schedule is full (${MAX_TASKS} tasks)`);
            const now = resolveNow(options);
            const task = {
                id: makeId(),
                prompt: cleanPrompt,
                intervalMs,
                nextRunAt: now + intervalMs,
                createdAt: now,
                enabled: true,
            };
            const saved = await persistTasks(filePath, [...loaded.value, task]);
            if (!saved.ok)
                return fail(`Cannot add schedule: ${saved.error}`);
            return ok(copyTask(task));
        }
        catch (err) {
            logger.warn('Schedule: could not add task', { err: errorMessage(err) });
            return fail(`Could not add schedule: ${errorMessage(err)}`);
        }
    });
}
/** Enabled tasks due at or before `now`, oldest first. Never writes to the store. */
export async function dueTasks(options) {
    try {
        const loaded = await readSchedule(scheduleStorePath(options));
        if (!loaded.ok)
            return loaded;
        const now = resolveNow(options);
        const due = loaded.value
            .filter((task) => task.enabled && task.nextRunAt <= now)
            .sort((a, b) => a.nextRunAt - b.nextRunAt
            || a.createdAt - b.createdAt
            || a.id.localeCompare(b.id))
            .map(copyTask);
        return ok(due);
    }
    catch (err) {
        logger.warn('Schedule: could not list due tasks', { err: errorMessage(err) });
        return fail(`Could not list due tasks: ${errorMessage(err)}`);
    }
}
/**
 * Record a run: set `lastRunAt` and skip forward by whole intervals until the
 * next run is strictly after `now`. A long downtime therefore produces one
 * future run instead of a burst of overdue ones.
 */
export async function markRun(id, options) {
    return serialize(async () => {
        try {
            const taskId = sanitizeId(id);
            if (!taskId)
                return fail('Invalid task id');
            const filePath = scheduleStorePath(options);
            const loaded = await readSchedule(filePath);
            if (!loaded.ok)
                return fail(`Cannot mark run: ${loaded.error}`);
            const index = loaded.value.findIndex((task) => task.id === taskId);
            if (index < 0)
                return fail(`Task not found: ${taskId}`);
            const now = resolveNow(options);
            const current = loaded.value[index];
            let nextRunAt = current.nextRunAt;
            if (nextRunAt <= now) {
                const steps = Math.floor((now - nextRunAt) / current.intervalMs) + 1;
                nextRunAt += steps * current.intervalMs;
                if (!isFiniteNumber(nextRunAt))
                    return fail('Cannot mark run: next run time overflowed');
            }
            const updated = { ...copyTask(current), nextRunAt, lastRunAt: now };
            const tasks = loaded.value.slice();
            tasks[index] = updated;
            const saved = await persistTasks(filePath, tasks);
            if (!saved.ok)
                return fail(`Cannot mark run: ${saved.error}`);
            return ok(copyTask(updated));
        }
        catch (err) {
            logger.warn('Schedule: could not mark run', { err: errorMessage(err) });
            return fail(`Could not mark run: ${errorMessage(err)}`);
        }
    });
}
/** Remove a task by id. `false` means the id was not in the store. */
export async function removeSchedule(id, options) {
    return serialize(async () => {
        try {
            const taskId = sanitizeId(id);
            if (!taskId)
                return fail('Invalid task id');
            const filePath = scheduleStorePath(options);
            const loaded = await readSchedule(filePath);
            if (!loaded.ok)
                return fail(`Cannot remove schedule: ${loaded.error}`);
            if (!loaded.value.some((task) => task.id === taskId))
                return ok(false);
            const saved = await persistTasks(filePath, loaded.value.filter((task) => task.id !== taskId));
            if (!saved.ok)
                return fail(`Cannot remove schedule: ${saved.error}`);
            return ok(true);
        }
        catch (err) {
            logger.warn('Schedule: could not remove task', { err: errorMessage(err) });
            return fail(`Could not remove schedule: ${errorMessage(err)}`);
        }
    });
}

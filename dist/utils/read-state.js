/**
 * read-state.ts — task-scoped memory of what the model has already read.
 *
 * Two behaviours depend on it:
 *  - read dedupe: reading a file whose mtime/size did not change returns a short
 *    stub instead of the whole body, so long sessions stop paying for the same
 *    bytes twice;
 *  - edit safety: a mutating file tool refuses to touch an existing file the
 *    model has not read in this session, which is the cheapest guard against a
 *    hallucinated rewrite.
 *
 * State is keyed by session, and must be cleared at a compaction boundary: once
 * the bytes leave the context, "the model already saw this" is no longer true.
 * Everything here is synchronous, cheap and never throws.
 */
import path from 'node:path';
/** Bound per session so a long-running task cannot grow without limit. */
const MAX_ENTRIES_PER_SESSION = 4000;
const sessions = new Map();
function key(sessionId) {
    return sessionId && sessionId.trim() ? sessionId : 'default';
}
/** Absolute, platform-normalised key so `./a.ts` and `a.ts` are one entry. */
export function normalizeStatePath(filePath, cwd) {
    const resolved = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function bucket(sessionId) {
    const k = key(sessionId);
    let map = sessions.get(k);
    if (!map) {
        map = new Map();
        sessions.set(k, map);
    }
    return map;
}
function trim(map) {
    if (map.size <= MAX_ENTRIES_PER_SESSION)
        return;
    // Map iterates in insertion order, so the oldest entries go first.
    const excess = map.size - MAX_ENTRIES_PER_SESSION;
    let removed = 0;
    for (const k of map.keys()) {
        map.delete(k);
        if (++removed >= excess)
            break;
    }
}
function estimateLines(text) {
    if (!text)
        return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10)
            count++;
    }
    return count;
}
/** Record that the model received this file's bytes. */
export function recordFileRead(sessionId, filePath, stat, content) {
    const map = bucket(sessionId);
    const record = {
        source: 'read',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        lines: content === undefined ? 0 : estimateLines(content),
        at: Date.now(),
    };
    map.set(normalizeStatePath(filePath), record);
    trim(map);
    return record;
}
/** Record that the model authored this file (fresh content, not seen as bytes). */
export function recordFileWrite(sessionId, filePath, stat, content) {
    const map = bucket(sessionId);
    const record = {
        source: 'write',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        lines: content === undefined ? 0 : estimateLines(content),
        at: Date.now(),
    };
    map.set(normalizeStatePath(filePath), record);
    trim(map);
    return record;
}
export function readRecordFor(sessionId, filePath) {
    return sessions.get(key(sessionId))?.get(normalizeStatePath(filePath));
}
/** True only when the model actually saw the bytes this session. */
export function wasFileRead(sessionId, filePath) {
    return readRecordFor(sessionId, filePath)?.source === 'read';
}
export function hasFileState(sessionId, filePath) {
    return readRecordFor(sessionId, filePath) !== undefined;
}
/** True when the file has not changed since the last read/write we recorded. */
export function isFileUnchangedSinceRead(sessionId, filePath, stat) {
    const record = readRecordFor(sessionId, filePath);
    if (!record)
        return false;
    return record.mtimeMs === stat.mtimeMs && record.size === stat.size;
}
/** Human-readable stub returned instead of re-sending an unchanged body. */
export function unchangedReadStub(filePath, record) {
    const when = new Date(record.at).toISOString().replace('T', ' ').slice(0, 19);
    const shape = record.lines > 0 ? `${record.lines} lines, ${record.size} bytes` : `${record.size} bytes`;
    return [
        `File unchanged since your last read (${shape}, read at ${when}): ${filePath}`,
        'The content is already in this conversation. Call read_file with full=true to force a full re-read.',
    ].join('\n');
}
export function clearReadState(sessionId) {
    if (sessionId === undefined)
        sessions.clear();
    else
        sessions.delete(key(sessionId));
}
export function readStateSize(sessionId) {
    return sessions.get(key(sessionId))?.size ?? 0;
}
/** Test helper: drop every session bucket. */
export function resetReadStateForTests() {
    sessions.clear();
}

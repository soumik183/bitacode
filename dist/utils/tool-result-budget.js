/**
 * tool-result-budget.ts — keeps large tool output out of the context window
 * without losing it.
 *
 * Instead of truncating a 300 KB build log to the first 50 000 characters (which
 * usually cuts off exactly the error), the full text is written to a spill file
 * under the data directory and the model receives a short head/tail preview plus
 * the path. The path goes through the normal path validation, so the model can
 * read sections back with `read_file` and grep it with `search_files`.
 *
 * Everything here is best-effort: if the spill write fails we fall back to plain
 * truncation rather than failing the tool call.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';
export const DEFAULT_MAX_INLINE = 20_000;
const DEFAULT_PREVIEW = 3_000;
/** Hard ceiling: never write more than this to disk from one tool result. */
const MAX_SPILL_BYTES = 32 * 1024 * 1024;
function dataDir() {
    const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'bitacode', 'spill');
}
function safeRunId(runId) {
    const cleaned = (runId ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return cleaned || 'session';
}
function head(text, count) {
    return text.slice(0, count);
}
function tail(text, count) {
    return count >= text.length ? text : text.slice(text.length - count);
}
/** Path shown to the model, relative to the data dir so it stays readable. */
export function spillDisplayPath(filePath) {
    return filePath;
}
function countLines(text) {
    let count = 1;
    for (let i = 0; i < text.length; i++)
        if (text.charCodeAt(i) === 10)
            count++;
    return count;
}
/** Synchronous truncation fallback, used when spilling is impossible. */
export function truncateWithNote(text, limit) {
    if (text.length <= limit)
        return text;
    const marker = `\n\n…[truncated ${text.length - limit} characters]`;
    const keep = Math.max(0, limit - marker.length);
    return text.slice(0, keep) + marker;
}
/**
 * Apply the budget. Writes the full text to disk when it is over budget and
 * returns a preview that names the spill file.
 */
export async function applyToolResultBudget(text, options = {}) {
    const maxInline = options.maxInlineChars ?? DEFAULT_MAX_INLINE;
    const preview = options.previewChars ?? DEFAULT_PREVIEW;
    const originalChars = text.length;
    if (originalChars <= maxInline) {
        return { content: text, spilled: false, originalChars };
    }
    const directory = options.directory ?? path.join(dataDir(), safeRunId(options.runId));
    const fileName = `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const filePath = path.join(directory, fileName);
    try {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_SPILL_BYTES) {
            throw new Error(`result is ${bytes} bytes, over the ${MAX_SPILL_BYTES}-byte spill limit`);
        }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(filePath, text, { mode: 0o600 });
        const lines = countLines(text);
        const half = Math.max(200, Math.floor(preview / 2));
        const note = [
            '',
            '──── full output saved ────',
            `File: ${filePath}`,
            `Size: ${lines} lines, ${bytes} bytes (only ${preview} characters are shown here)`,
            'Use read_file with offset/limit to page through it, or search_files to find the part you need.',
            '────',
            '',
        ].join('\n');
        const content = [
            head(text, half),
            note,
            tail(text, half),
        ].join('');
        logger.info('Spilled tool result to disk', { file: filePath, bytes, originalChars });
        return { content, spilled: true, path: filePath, bytes, originalChars };
    }
    catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        logger.warn('Could not spill tool result; truncating instead', { error, originalChars });
        const marker = `\n\n…[truncated: full output of ${originalChars.toLocaleString()} characters could not be saved (${error})]`;
        return {
            content: truncateWithNote(text, Math.max(maxInline, preview)) + marker,
            spilled: false,
            originalChars,
            error,
        };
    }
}
/** Remove spill files older than `maxAgeMs` (default 7 days). Best-effort. */
export async function pruneSpillFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const root = dataDir();
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(target);
                continue;
            }
            try {
                const stat = await fs.stat(target);
                if (stat.mtimeMs < cutoff) {
                    await fs.rm(target, { force: true });
                    removed++;
                }
            }
            catch {
                // ignore
            }
        }
    };
    await walk(root);
    return removed;
}

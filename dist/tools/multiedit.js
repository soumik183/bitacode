/** multiedit tool — apply validated string replacements across multiple files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';
import { approve, cancelled, computeUnifiedDiff, errorMessage, readRegularFile, requireString, safe, } from './file-helpers.js';
const MAX_EDIT_FILES = 20;
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
export const multieditTool = {
    type: 'function',
    function: {
        name: 'multiedit',
        description: 'Apply string replacements to multiple files in one call. Every edit is validated ' +
            'before anything is written; if any edit fails, no files are changed. Each file requires approval.',
        parameters: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    description: 'Edits to apply, each with file_path, old_string, new_string and optional expected_replacements.',
                    items: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: 'Path to the file to edit.' },
                            old_string: { type: 'string', description: 'Exact text to find.' },
                            new_string: { type: 'string', description: 'Replacement text.' },
                            expected_replacements: { type: 'number', description: 'Expected number of matches (default 1).' },
                        },
                        required: ['file_path', 'old_string', 'new_string'],
                    },
                },
            },
            required: ['edits'],
        },
    },
};
// ─── Local helpers ───
function asString(value, name) {
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string.`);
    return value;
}
function expectedCount(value) {
    if (value == null)
        return 1;
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1) {
        throw new Error('expected_replacements must be a positive integer.');
    }
    return count;
}
async function atomicWrite(target, content, mode) {
    const temp = path.join(path.dirname(target), `.bitacode-fileops-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(target)}`);
    try {
        await fs.writeFile(temp, content, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
        await fs.rename(temp, target);
    }
    finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
    }
}
function countOccurrences(haystack, needle) {
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}
function replaceOccurrences(content, oldString, newString, count) {
    // Work backwards so earlier offsets stay valid, and never re-scan replaced text.
    let result = content;
    let index = 0;
    const positions = [];
    while (count-- > 0 && (index = result.indexOf(oldString, index)) !== -1) {
        positions.push(index);
        index += oldString.length;
    }
    for (const position of positions.reverse()) {
        result = result.slice(0, position) + newString + result.slice(position + oldString.length);
    }
    return result;
}
// ─── Handler ───
export async function multiedit(edits, sessionId) {
    return safe(async () => {
        if (!Array.isArray(edits))
            throw new Error('edits must be an array of edit operations.');
        if (edits.length === 0)
            throw new Error('edits must contain at least one edit.');
        if (edits.length > MAX_EDIT_FILES) {
            throw new Error(`Too many edits: ${edits.length} (limit is ${MAX_EDIT_FILES}).`);
        }
        // Phase 1 — validate and stage every edit in memory. No writes yet.
        const plan = [];
        const originals = new Map();
        const working = new Map();
        const modes = new Map();
        for (let i = 0; i < edits.length; i++) {
            const raw = edits[i];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error(`edits[${i}] must be an object.`);
            }
            const edit = raw;
            const filePath = requireString(edit.file_path, `edits[${i}].file_path`);
            const oldString = asString(edit.old_string, `edits[${i}].old_string`);
            const newString = asString(edit.new_string, `edits[${i}].new_string`);
            if (oldString.length === 0)
                throw new Error(`edits[${i}].old_string cannot be empty.`);
            const expected = expectedCount(edit.expected_replacements);
            let validated;
            try {
                validated = await validatePath(filePath);
            }
            catch (err) {
                throw new Error(`edits[${i}]: ${errorMessage(err)}`);
            }
            if (!working.has(validated)) {
                const file = await readRegularFile(validated, filePath, MAX_EDIT_FILE_BYTES);
                originals.set(validated, file.content);
                working.set(validated, file.content);
                modes.set(validated, file.mode);
            }
            const current = working.get(validated);
            const count = countOccurrences(current, oldString);
            if (count !== expected) {
                throw new Error(`edits[${i}] (${filePath}): found ${count} occurrence(s) of old_string, expected ${expected}. No files were changed.`);
            }
            working.set(validated, replaceOccurrences(current, oldString, newString, count));
            plan.push({ filePath, validated, count, oldString, newString });
        }
        // One approval per unique file, before any write.
        const counts = new Map();
        for (const item of plan)
            counts.set(item.validated, (counts.get(item.validated) ?? 0) + item.count);
        for (const [validated, count] of counts) {
            const label = plan.find((item) => item.validated === validated).filePath;
            const approved = await approve('file_edit', `Edit file: ${label} (${count} replacement${count === 1 ? '' : 's'})`, `Multi-file edit: ${count} replacement(s) in ${label}`, `file_edit:${validated}`, sessionId);
            if (!approved)
                return cancelled(`multi-file edit of ${label}`);
        }
        // Phase 2 — write, restoring already-written files if any write fails.
        const written = [];
        try {
            for (const validated of originals.keys()) {
                await atomicWrite(validated, working.get(validated), modes.get(validated));
                written.push(validated);
            }
        }
        catch (err) {
            const failures = [];
            for (const done of written.reverse()) {
                try {
                    await atomicWrite(done, originals.get(done), modes.get(done));
                }
                catch (rollbackErr) {
                    failures.push(`${done}: ${errorMessage(rollbackErr)}`);
                }
            }
            const note = failures.length
                ? ` Rollback FAILED for: ${failures.join('; ')}`
                : ' All changed files were restored.';
            throw new Error(`Failed to write multi-file edit: ${errorMessage(err)}.${note}`);
        }
        const summaries = [...originals.keys()].map((validated) => {
            const label = plan.find((item) => item.validated === validated).filePath;
            const diff = computeUnifiedDiff(originals.get(validated), working.get(validated), label);
            return `--- ${label} (${counts.get(validated)} replacement(s))\n${diff || '(no textual change)'}`;
        });
        return `Successfully edited ${originals.size} file(s):\n${summaries.join('\n\n')}`;
    });
}

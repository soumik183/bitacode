/**
 * tool-verify.ts — cheap postcondition check for mutating tools.
 *
 * A tool can report success and still leave the workspace in the wrong state: a
 * relative path resolved elsewhere, an edit whose anchor matched the wrong
 * block, a rename whose destination was not created. After a mutating call we
 * re-read the target and attach a short note to the tool result, so the model
 * sees the problem on the same turn instead of two turns later.
 *
 * Deliberately shallow: existence, size, and the specific strings the model said
 * it was writing. Anything deeper belongs to the project's own checks
 * (`autoverify.ts`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
/** Files larger than this are not read for content checks. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MUTATING = new Set([
    'write_file', 'edit_file', 'apply_patch', 'multiedit',
    'delete', 'rename', 'move', 'copy', 'mkdir',
]);
function resolve(cwd, target) {
    if (typeof target !== 'string' || !target.trim())
        return null;
    return path.resolve(cwd, target.trim());
}
async function statOf(target) {
    try {
        const info = await fs.stat(target);
        return { exists: true, size: info.size, directory: info.isDirectory() };
    }
    catch {
        return { exists: false, size: 0, directory: false };
    }
}
async function readSmall(target) {
    try {
        const info = await fs.stat(target);
        if (!info.isFile() || info.size > MAX_READ_BYTES)
            return null;
        return await fs.readFile(target, 'utf8');
    }
    catch {
        return null;
    }
}
function failedResult(result) {
    return /^\s*error[:\s]/i.test(result) || /\bfailed\b/i.test(result.slice(0, 200));
}
/** Patch targets, taken from the unified diff headers. */
function patchTargets(patch) {
    if (typeof patch !== 'string')
        return [];
    const targets = [];
    for (const match of patch.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)) {
        const target = match[1]?.trim().split('\t')[0];
        if (target && target !== '/dev/null')
            targets.push(target);
    }
    return [...new Set(targets)];
}
async function verifySingle(target, expected) {
    const info = await statOf(target);
    if (!info.exists) {
        return { severity: 'fail', message: `verification failed: ${target} does not exist after the call` };
    }
    if (info.directory) {
        return { severity: 'ok', message: `verified: directory ${target} exists` };
    }
    if (info.size === 0) {
        return { severity: 'warn', message: `verification warning: ${target} is empty` };
    }
    if (expected) {
        const content = await readSmall(target);
        if (content !== null) {
            const needle = expected.split('\n').find((line) => line.trim().length > 12);
            if (needle && !content.includes(needle.replace(/^\s+/, '').slice(0, 60))) {
                return {
                    severity: 'fail',
                    message: `verification failed: ${target} exists (${info.size} bytes) but does not contain the text that was meant to be written`,
                };
            }
        }
    }
    return { severity: 'ok', message: `verified: ${target} (${info.size} bytes)` };
}
/**
 * Check a tool's effect. Returns null when the call does not need checking or
 * failed on its own (its error is already the answer).
 */
export async function verifyToolPostcondition(input) {
    if (!MUTATING.has(input.tool))
        return null;
    if (failedResult(input.result))
        return null;
    const { tool, args, cwd } = input;
    const notes = [];
    switch (tool) {
        case 'write_file':
        case 'edit_file': {
            const target = resolve(cwd, args.file_path ?? args.path);
            if (!target)
                return null;
            const expected = tool === 'write_file'
                ? (typeof args.content === 'string' ? args.content : null)
                : (typeof args.new_string === 'string' ? args.new_string : null);
            notes.push(await verifySingle(target, expected));
            if (tool === 'edit_file' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
                const content = await readSmall(target);
                if (content && args.old_string !== args.new_string && content.includes(args.old_string)) {
                    notes.push({ severity: 'warn', message: 'the old text is still present; there may be more than one match' });
                }
            }
            break;
        }
        case 'apply_patch': {
            const targets = patchTargets(args.patch);
            for (const target of targets.slice(0, 4)) {
                const absolute = resolve(cwd, target);
                if (absolute)
                    notes.push(await verifySingle(absolute));
            }
            break;
        }
        case 'multiedit': {
            if (Array.isArray(args.edits)) {
                for (const edit of args.edits.slice(0, 4)) {
                    if (!edit || typeof edit !== 'object')
                        continue;
                    const target = resolve(cwd, edit.file_path ?? edit.path);
                    if (target)
                        notes.push(await verifySingle(target));
                }
            }
            break;
        }
        case 'delete': {
            // `delete` also accepts a directory; either way it should be gone.
            const target = resolve(cwd, args.file_path ?? args.path);
            if (!target)
                return null;
            const info = await statOf(target);
            notes.push(info.exists
                ? { severity: 'fail', message: `verification failed: ${target} still exists after delete` }
                : { severity: 'ok', message: `verified: ${target} removed` });
            break;
        }
        case 'rename':
        case 'move':
        case 'copy': {
            const source = resolve(cwd, args.source);
            const destination = resolve(cwd, args.destination);
            if (!destination)
                return null;
            notes.push(await verifySingle(destination));
            if (tool !== 'copy' && source) {
                const info = await statOf(source);
                if (info.exists)
                    notes.push({ severity: 'warn', message: `source ${source} still exists` });
            }
            break;
        }
        case 'mkdir': {
            const target = resolve(cwd, args.directory_path ?? args.path ?? args.directory);
            if (!target)
                return null;
            const info = await statOf(target);
            notes.push(info.exists && info.directory
                ? { severity: 'ok', message: `verified: directory ${target}` }
                : { severity: 'fail', message: `verification failed: directory ${target} was not created` });
            break;
        }
        default:
            return null;
    }
    if (notes.length === 0)
        return null;
    const worst = notes.some((note) => note.severity === 'fail')
        ? 'fail'
        : notes.some((note) => note.severity === 'warn') ? 'warn' : 'ok';
    return { severity: worst, message: notes.map((note) => note.message).join('; ') };
}
/** Append the note to a tool result, keeping the original text first. */
export function renderVerifyNote(note) {
    return note ? `\n\n[postcondition] ${note.message}` : '';
}

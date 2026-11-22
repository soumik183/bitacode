/**
 * apply_patch tool — Apply a standard unified diff across one or more files.
 *
 * Every hunk is validated against the current file content before anything is
 * written, so a conflicting patch leaves the tree untouched. Authored with the
 * `diff` package (already a dependency) so we inherit its context/fuzz matching.
 */
import fs from 'node:fs/promises';
import { applyPatch as applyPatchToText, parsePatch } from 'diff';
import { validatePath } from '../utils/path-validation.js';
import { requestApproval } from '../utils/approval.js';
import { computeUnifiedDiff } from '../utils/unified-diff.js';
export const applyPatchTool = {
    type: 'function',
    function: {
        name: 'apply_patch',
        description: 'Apply a unified diff (one or more files/hunks) to the working directory. ' +
            'Context is verified before any file is changed; a conflicting patch writes nothing. ' +
            'Supports --- a/path / +++ b/path headers and /dev/null for new or deleted files.',
        parameters: {
            type: 'object',
            properties: {
                patch: { type: 'string', description: 'The unified diff text to apply.' },
            },
            required: ['patch'],
        },
    },
};
/** Normalise `a/path`, `b/path` and tabs with timestamps; null means /dev/null. */
function normalizeDiffPath(name) {
    if (!name || name === '/dev/null')
        return null;
    let p = name;
    const tab = p.indexOf('\t');
    if (tab >= 0)
        p = p.slice(0, tab);
    if (p.startsWith('a/') || p.startsWith('b/'))
        p = p.slice(2);
    return p || null;
}
function countChanges(lines) {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++'))
            added++;
        else if (line.startsWith('-') && !line.startsWith('---'))
            removed++;
    }
    return { added, removed };
}
export async function applyPatch(patch, sessionId) {
    if (typeof patch !== 'string' || patch.trim().length === 0) {
        return 'Error: patch is required (a unified diff).';
    }
    let parsed;
    try {
        parsed = parsePatch(patch);
    }
    catch (err) {
        return `Error: invalid unified diff: ${err.message}`;
    }
    if (!parsed || parsed.length === 0) {
        return 'Error: no file patches found in the diff.';
    }
    // Phase 1 — validate every file/hunk in memory. No writes happen here.
    const writes = [];
    for (const filePatch of parsed) {
        const newPath = normalizeDiffPath(filePatch.newFileName);
        const oldPath = normalizeDiffPath(filePatch.oldFileName);
        const isDelete = newPath === null;
        const isNew = oldPath === null;
        const targetPath = isDelete ? oldPath : newPath;
        if (!targetPath)
            return 'Error: patch has no target file path.';
        let validated;
        try {
            validated = await validatePath(targetPath);
        }
        catch (err) {
            return `Error: ${err.message}`;
        }
        let current = '';
        let existed = false;
        try {
            const stat = await fs.stat(validated);
            if (stat.isDirectory())
                return `Error: '${targetPath}' is a directory.`;
            current = await fs.readFile(validated, 'utf8');
            existed = true;
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                return `Error: cannot read '${targetPath}': ${err.message}`;
            if (!isNew && !isDelete)
                return `Error: file not found: '${targetPath}'.`;
        }
        if (isDelete && !existed)
            return `Error: cannot delete '${targetPath}': file not found.`;
        const result = applyPatchToText(current, filePatch);
        if (result === false) {
            return `Error: patch does not apply cleanly to '${targetPath}' (context mismatch). No files were changed.`;
        }
        let added = 0;
        let removed = 0;
        for (const hunk of filePatch.hunks) {
            const changes = countChanges(hunk.lines);
            added += changes.added;
            removed += changes.removed;
        }
        writes.push({ targetPath, validated, originalContent: current, newContent: result, isDelete, added, removed });
    }
    // Phase 2 — one file_edit approval per touched file.
    for (const write of writes) {
        const approved = await requestApproval({
            id: `apply-patch-${Date.now()}-${write.targetPath}`,
            type: 'file_edit',
            description: `Apply patch to ${write.targetPath}${write.isDelete ? ' (delete)' : ''}`,
            detail: `+${write.added} / -${write.removed} lines in ${write.targetPath}`,
            sessionId,
            sessionScopeKey: `file_edit:${write.validated}`,
        });
        if (!approved) {
            return `Operation cancelled: patch application to ${write.targetPath} was rejected by user. No files were changed.`;
        }
    }
    // Phase 3 — all validated and approved; now write.
    try {
        for (const write of writes) {
            if (write.isDelete)
                await fs.unlink(write.validated);
            else
                await fs.writeFile(write.validated, write.newContent, 'utf8');
        }
    }
    catch (err) {
        return `Error: failed to write patch result: ${err.message}`;
    }
    const summaries = writes.map((write) => {
        const meta = `+${write.added}/-${write.removed}${write.isDelete ? ' (deleted)' : ''}`;
        const diff = computeUnifiedDiff(write.originalContent, write.newContent, write.targetPath);
        return `--- ${write.targetPath} (${meta})${diff ? `\n${diff}` : ''}`;
    });
    return `Applied patch to ${writes.length} file(s):\n${summaries.join('\n\n')}`;
}

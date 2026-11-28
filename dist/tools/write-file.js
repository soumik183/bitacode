/**
 * write_file tool — Create or overwrite a file. Requires approval.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';
import { assertWritablePath } from '../utils/protected-paths.js';
import { requestApproval } from '../utils/approval.js';
import { recordRead, checkReadBefore } from '../utils/file-time.js';
import { computeUnifiedDiff } from '../utils/unified-diff.js';
const MAX_DIFF_READ_BYTES = 2 * 1024 * 1024;
export const writeFileTool = {
    type: 'function',
    function: {
        name: 'write_file',
        description: 'Create a new file or overwrite an existing file with the given content. Prefer edit_file for modifying existing files.',
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to write (relative to working directory).' },
                content: { type: 'string', description: 'The full content to write to the file.' },
            },
            required: ['file_path', 'content'],
        },
    },
};
export async function writeFile(filePath, content, sessionId) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return 'Error: file_path is required.';
    }
    if (typeof content !== 'string') {
        return 'Error: content must be a string.';
    }
    // validatePath handles non-existent files and parent directories
    let validated;
    try {
        validated = await validatePath(filePath);
        assertWritablePath(validated);
    }
    catch (err) {
        return `Error: ${err.message}`;
    }
    // Staleness guard: refuse to overwrite a file that changed on disk after the
    // model last read it. New files and never-read files are unaffected.
    if (sessionId) {
        const staleError = checkReadBefore(sessionId, validated);
        if (staleError)
            return staleError;
    }
    // Preserve the permissions of an existing file; new files get the default.
    let mode;
    let previousContent = '';
    try {
        const stats = await fs.stat(validated);
        if (stats.isDirectory()) {
            return `Error: '${filePath}' is a directory.`;
        }
        mode = stats.mode & 0o777;
        if (stats.size > 0 && stats.size <= MAX_DIFF_READ_BYTES) {
            try {
                previousContent = await fs.readFile(validated, 'utf8');
            }
            catch {
                // Read failed; still allow the write, just without a red/green diff.
            }
        }
    }
    catch {
        // New file
    }
    // Request approval
    const preview = content.length > 500
        ? `${content.slice(0, 250)}\n... (${content.length} chars total) ...\n${content.slice(-250)}`
        : content;
    const approved = await requestApproval({
        id: `write-${Date.now()}`,
        type: 'file_write',
        description: `Write file: ${filePath}`,
        detail: preview,
        sessionId,
        sessionScopeKey: `file_write:${validated}`,
    });
    if (!approved) {
        return `Operation cancelled: write to ${filePath} was rejected by user.`;
    }
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(validated), { recursive: true });
    // Security: Atomic write with symlink protection
    // Uses O_CREAT|O_EXCL ('wx' flag) to prevent symlink attacks
    const tmpPath = path.join(path.dirname(validated), `.bitacode-write-${process.pid}-${Date.now()}-${path.basename(validated)}`);
    let fd;
    try {
        // Open with O_CREAT|O_EXCL - atomically creates or fails if exists
        fd = await fs.open(tmpPath, 'wx', mode ?? 0o666);
        if (mode !== undefined) {
            await fd.chmod(mode);
        }
        await fd.writeFile(content, 'utf8');
        await fd.sync();
        await fd.close();
        fd = undefined;
        await fs.rename(tmpPath, validated);
    }
    catch (err) {
        if (fd !== undefined) {
            try {
                await fd.close();
            }
            catch { /* ignore */ }
        }
        try {
            await fs.unlink(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
    finally {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
    const lines = content.split('\n').length;
    // Record the write as a read so a follow-up edit can detect external changes.
    if (sessionId) {
        recordRead(sessionId, validated);
    }
    const header = `Successfully wrote ${lines} lines to ${filePath}`;
    const diff = computeUnifiedDiff(previousContent, content, filePath);
    return diff ? `${header}\n${diff}` : header;
}

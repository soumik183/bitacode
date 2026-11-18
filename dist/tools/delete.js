/** delete tool — delete a file or directory inside the working directory. */
import fs from 'node:fs/promises';
import { validatePath } from '../utils/path-validation.js';
import { approve, asBoolean, assertNotProtected, cancelled, errorCode, errorMessage, requireString, safe, } from './file-helpers.js';
export const deleteTool = {
    type: 'function',
    function: {
        name: 'delete',
        description: 'Delete a file or directory inside the working directory. Requires approval. ' +
            'Directories need recursive: true. The project root itself cannot be deleted.',
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path of the file or directory to delete.' },
                recursive: { type: 'boolean', description: 'Delete directories and their contents (default false).' },
            },
            required: ['file_path'],
        },
    },
};
export async function deletePath(filePath, recursive, sessionId) {
    return safe(async () => {
        const requested = requireString(filePath, 'file_path');
        const validated = await validatePath(requested);
        assertNotProtected(validated, `delete '${requested}'`);
        let stat;
        try {
            stat = await fs.lstat(validated);
        }
        catch (err) {
            if (errorCode(err) === 'ENOENT')
                throw new Error(`'${requested}': path not found.`);
            throw new Error(`'${requested}': cannot access path: ${errorMessage(err)}`);
        }
        const isDirectory = stat.isDirectory();
        if (isDirectory && !asBoolean(recursive)) {
            throw new Error(`'${requested}' is a directory; pass recursive: true to delete it.`);
        }
        const approved = await approve('shell_command', `Delete ${requested}${isDirectory ? ' (recursive)' : ''}`, `Path: ${validated}\nType: ${isDirectory ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file'}`, `delete:${validated}`, sessionId);
        if (!approved)
            return cancelled(`deletion of ${requested}`);
        await fs.rm(validated, { recursive: asBoolean(recursive), force: false });
        return `Deleted ${requested}${isDirectory ? ' (directory)' : ''}.`;
    });
}

/**
 * list_directory tool — List contents of a directory.
 */
import fs from 'node:fs/promises';
import { validatePath } from '../utils/path-validation.js';
export const listDirectoryTool = {
    type: 'function',
    function: {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns entries with [FILE] or [DIR] prefixes.',
        parameters: {
            type: 'object',
            properties: {
                directory_path: {
                    type: 'string',
                    description: 'Path to the directory to list (relative to working directory). Defaults to ".".',
                },
            },
            required: [],
        },
    },
};
const MAX_ENTRIES = 500;
export async function listDirectory(directoryPath = '.') {
    if (typeof directoryPath !== 'string' || directoryPath.length === 0) {
        directoryPath = '.';
    }
    let validated;
    try {
        validated = await validatePath(directoryPath);
    }
    catch (err) {
        return `Error: ${err.message}`;
    }
    let stats;
    try {
        stats = await fs.stat(validated);
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return `Directory not found: '${directoryPath}'`;
        }
        return `Error: cannot access '${directoryPath}': ${err.message}`;
    }
    if (!stats.isDirectory()) {
        return `Error: '${directoryPath}' is not a directory. Use read_file for files.`;
    }
    let entries;
    try {
        entries = await fs.readdir(validated, { withFileTypes: true });
    }
    catch (err) {
        return `Error: cannot list '${directoryPath}': ${err.message}`;
    }
    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory())
            return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    const shown = entries.slice(0, MAX_ENTRIES);
    const lines = shown.map((entry) => {
        const prefix = entry.isDirectory() ? '[DIR] ' : entry.isSymbolicLink() ? '[LINK]' : '[FILE]';
        return `${prefix} ${entry.name}`;
    });
    const suffix = entries.length > shown.length
        ? `\n... (${entries.length - shown.length} more entries not shown)`
        : '';
    return `Contents of ${directoryPath} (${entries.length} entries):\n${lines.join('\n')}${suffix}`;
}

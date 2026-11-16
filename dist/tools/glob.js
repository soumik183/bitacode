/**
 * glob tool — Find files by name pattern.
 *
 * Complements search_files: glob matches file paths, search_files matches
 * file contents. Paths are returned relative to the working directory so
 * they can be passed straight to read_file/edit_file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkingDirectory, validatePath } from '../utils/path-validation.js';
import { SKIP_DIRS } from './search-files.js';
export const globTool = {
    type: 'function',
    function: {
        name: 'glob',
        description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{ts,tsx}", "*.json"). ' +
            'Returns matching file paths relative to the working directory. ' +
            'Use search_files to search file contents instead.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to match file paths against, e.g. "**/*.ts".' },
                directory_path: { type: 'string', description: 'Directory to search in. Defaults to ".".' },
            },
            required: ['pattern'],
        },
    },
};
const MAX_RESULTS = 200;
const MAX_SCANNED = 20_000;
const MAX_DEPTH = 12;
/** Translate a glob pattern into a regular expression source. */
function translateGlob(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                i++;
                if (pattern[i + 1] === '/') {
                    i++;
                    out += '(?:.*/)?'; // **/ matches zero or more directories
                }
                else {
                    out += '.*';
                }
            }
            else {
                out += '[^/]*';
            }
        }
        else if (ch === '?') {
            out += '[^/]';
        }
        else if (ch === '{') {
            const end = pattern.indexOf('}', i + 1);
            if (end === -1) {
                out += '\\{';
            }
            else {
                const alternatives = pattern.slice(i + 1, end).split(',').map(translateGlob);
                out += `(?:${alternatives.join('|')})`;
                i = end;
            }
        }
        else if (ch === '[') {
            const end = pattern.indexOf(']', i + 1);
            if (end === -1) {
                out += '\\[';
            }
            else {
                let charClass = pattern.slice(i, end + 1);
                // Glob uses [!abc]; regex uses [^abc].
                if (charClass[1] === '!') {
                    charClass = `[^${charClass.slice(2)}`;
                }
                out += charClass;
                i = end;
            }
        }
        else if ('\\^$+.|()'.includes(ch)) {
            out += `\\${ch}`;
        }
        else {
            out += ch;
        }
    }
    return out;
}
function globToRegExp(pattern) {
    let normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    // A pattern without a slash matches at any depth, like most glob tools.
    if (!normalized.includes('/')) {
        normalized = `**/${normalized}`;
    }
    return new RegExp(`^${translateGlob(normalized)}$`);
}
export async function globFiles(pattern, directoryPath = '.') {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
        return 'Error: pattern is required.';
    }
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
        return `Error: '${directoryPath}' is not a directory.`;
    }
    let regex;
    try {
        regex = globToRegExp(pattern);
    }
    catch (err) {
        return `Error: invalid glob pattern "${pattern}": ${err.message}`;
    }
    const root = getWorkingDirectory();
    const matches = [];
    let scanned = 0;
    let scanLimitReached = false;
    async function walk(dir, depth) {
        if (matches.length >= MAX_RESULTS || scanLimitReached || depth > MAX_DEPTH)
            return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return; // Unreadable directory — skip
        }
        for (const entry of entries) {
            if (matches.length >= MAX_RESULTS || scanLimitReached)
                return;
            if (++scanned > MAX_SCANNED) {
                scanLimitReached = true;
                return;
            }
            // Skip symlinks to prevent cycles and escapes
            if (entry.isSymbolicLink())
                continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    await walk(fullPath, depth + 1);
                }
                continue;
            }
            if (!entry.isFile())
                continue;
            const relative = path.relative(root, fullPath).split(path.sep).join('/');
            if (regex.test(relative)) {
                matches.push(relative);
            }
        }
    }
    await walk(validated, 0);
    matches.sort((a, b) => a.localeCompare(b));
    if (matches.length === 0) {
        return scanLimitReached
            ? `No files matched "${pattern}" (stopped after scanning ${MAX_SCANNED} entries in ${directoryPath})`
            : `No files matched "${pattern}" in ${directoryPath}`;
    }
    let suffix = '';
    if (matches.length >= MAX_RESULTS) {
        suffix = `\n(results truncated at ${MAX_RESULTS})`;
    }
    else if (scanLimitReached) {
        suffix = '\n(scan limit reached before completing the search)';
    }
    return `Found ${matches.length} file(s) matching "${pattern}":\n${matches.join('\n')}${suffix}`;
}

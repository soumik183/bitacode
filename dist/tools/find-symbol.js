/** find_symbol tool — local symbol declaration search (ripgrep with JS fallback). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkingDirectory, validatePath } from '../utils/path-validation.js';
import { SKIP_DIRS } from './search-files.js';
import { validQuery } from './search-helpers.js';
const execFileAsync = promisify(execFile);
const MAX_SYMBOL_RESULTS = 100;
const MAX_FILE_SIZE = 1024 * 1024;
export const findSymbolTool = {
    type: 'function',
    function: {
        name: 'find_symbol',
        description: 'Find symbol declarations in the local repository (function, class, interface, type, variable). ' +
            'Returns path:line: match lines.',
        parameters: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name to find, e.g. "parseConfig".' },
                directory_path: { type: 'string', description: 'Directory to search in. Defaults to ".".' },
                kind: {
                    type: 'string',
                    enum: ['function', 'class', 'interface', 'type', 'variable', 'any'],
                    description: 'Kind of declaration to match. Defaults to "any".',
                },
            },
            required: ['symbol'],
        },
    },
};
const SYMBOL_KINDS = new Set(['function', 'class', 'interface', 'type', 'variable', 'any']);
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function symbolPattern(kind, symbol) {
    const s = escapeRegex(symbol);
    const patterns = {
        function: `\\bfunction\\s+${s}\\b`,
        class: `\\bclass\\s+${s}\\b`,
        interface: `\\binterface\\s+${s}\\b`,
        type: `\\btype\\s+${s}\\b`,
        variable: `\\b(?:const|let|var)\\s+${s}\\b`,
    };
    if (kind === 'any') {
        return `\\b(?:function|class|interface|type|const|let|var)\\s+${s}\\b`;
    }
    return patterns[kind];
}
function displayPath(absolutePath) {
    return path.relative(getWorkingDirectory(), absolutePath).split(path.sep).join('/');
}
let hasRipgrep = false;
try {
    execFileSync('rg', ['--version'], { stdio: 'pipe' });
    hasRipgrep = true;
}
catch {
    // ripgrep not available — use the JS walk fallback.
}
export async function findSymbol(symbol, directoryPath = '.', kind = 'any') {
    if (!validQuery(symbol))
        return 'Error: symbol is required.';
    const name = symbol.trim();
    if (name.length > 200)
        return `Error: symbol too long (${name.length} characters, max 200).`;
    const selectedKind = typeof kind === 'string' ? kind.toLowerCase() : 'any';
    if (!SYMBOL_KINDS.has(selectedKind)) {
        return `Error: invalid kind "${kind}". Expected one of: function, class, interface, type, variable, any.`;
    }
    let validated;
    try {
        validated = await validatePath(directoryPath || '.');
    }
    catch (err) {
        return `Error: ${err.message}`;
    }
    let stats;
    try {
        stats = await fs.stat(validated);
    }
    catch (err) {
        return err?.code === 'ENOENT'
            ? `Directory not found: '${directoryPath}'`
            : `Error: cannot access '${directoryPath}': ${err?.message ?? String(err)}`;
    }
    if (!stats.isDirectory()) {
        return `Error: '${directoryPath}' is not a directory. Pass a directory to search in.`;
    }
    const pattern = symbolPattern(selectedKind, name);
    try {
        if (hasRipgrep)
            return await findSymbolWithRipgrep(pattern, name, validated, directoryPath);
        return await findSymbolWithJs(pattern, name, validated, directoryPath);
    }
    catch (err) {
        return `Error: symbol search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}
async function findSymbolWithRipgrep(pattern, name, validated, directoryPath) {
    const args = [
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--color=never',
        '--max-filesize=1M',
        '--regexp',
        pattern,
        validated,
    ];
    let stdout;
    try {
        ({ stdout } = (await execFileAsync('rg', args, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30_000,
        })));
    }
    catch (err) {
        const status = typeof err?.code === 'number' ? err.code : err?.status;
        if (status === 1)
            return `No symbol "${name}" found in ${directoryPath}.`;
        if (status === 2)
            return `Error: ripgrep error: ${err?.stderr?.toString() || err?.message}`;
        return findSymbolWithJs(pattern, name, validated, directoryPath);
    }
    const results = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
        if (results.length >= MAX_SYMBOL_RESULTS)
            break;
        const first = line.indexOf(':');
        const second = line.indexOf(':', first + 1);
        if (first === -1 || second === -1)
            continue;
        const file = line.slice(0, first);
        const num = line.slice(first + 1, second);
        let content = line.slice(second + 1).trim();
        if (content.length > 300)
            content = content.slice(0, 300) + '...';
        results.push(`${displayPath(path.resolve(file))}:${num}: ${content}`);
    }
    return formatSymbolResults(name, results);
}
async function findSymbolWithJs(pattern, name, validated, directoryPath) {
    let regex;
    try {
        regex = new RegExp(pattern, 'g');
    }
    catch (err) {
        return `Error: invalid symbol pattern: ${err instanceof Error ? err.message : String(err)}`;
    }
    const results = [];
    const visitedInodes = new Set();
    async function walk(dir) {
        if (results.length >= MAX_SYMBOL_RESULTS)
            return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= MAX_SYMBOL_RESULTS)
                break;
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                try {
                    const st = await fs.stat(full);
                    const key = `${st.dev}:${st.ino}`;
                    if (visitedInodes.has(key))
                        continue;
                    visitedInodes.add(key);
                }
                catch {
                    continue;
                }
                await walk(full);
                continue;
            }
            if (!entry.isFile())
                continue;
            try {
                const st = await fs.stat(full);
                if (st.size > MAX_FILE_SIZE)
                    continue;
                const content = await fs.readFile(full, 'utf8');
                if (content.includes('\0'))
                    continue;
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && results.length < MAX_SYMBOL_RESULTS; i++) {
                    regex.lastIndex = 0;
                    if (!regex.test(lines[i]))
                        continue;
                    let text = lines[i].trim();
                    if (text.length > 300)
                        text = text.slice(0, 300) + '...';
                    results.push(`${displayPath(full)}:${i + 1}: ${text}`);
                }
            }
            catch {
                // Skip unreadable/binary files.
            }
        }
    }
    await walk(validated);
    return formatSymbolResults(name, results, directoryPath);
}
function formatSymbolResults(name, results, directoryPath) {
    if (results.length === 0) {
        return directoryPath
            ? `No symbol "${name}" found in ${directoryPath}.`
            : `No symbol "${name}" found.`;
    }
    const suffix = results.length >= MAX_SYMBOL_RESULTS ? `\n(results truncated at ${MAX_SYMBOL_RESULTS})` : '';
    return `Found ${results.length} match(es) for symbol "${name}":\n${results.join('\n')}${suffix}`;
}

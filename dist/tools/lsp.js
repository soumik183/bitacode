/**
 * LSP-ish navigation tools using regex/heuristics over the local repo.
 *
 * No language server is required: declarations and references are found by
 * scanning source files, and diagnostics shell out to the project's `tsc`
 * (with a 30 s timeout) when a tsconfig is present. Every handler returns a
 * bounded string and never throws.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { SKIP_DIRS } from './search-files.js';
import { validQuery } from './search-helpers.js';
const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HITS = 200;
const MAX_DIAGNOSTIC_LINES = 50;
const SOURCE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.rb', '.cs', '.php',
]);
export const goToDefinitionTool = {
    type: 'function',
    function: {
        name: 'go_to_definition',
        description: 'Find where a symbol is declared (function, class, interface, type, enum, variable) using ' +
            'regex heuristics over the local repository. Returns path:line: match lines.',
        parameters: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name to find, e.g. "parseConfig".' },
                directory_path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' },
            },
            required: ['symbol'],
        },
    },
};
export const findReferencesTool = {
    type: 'function',
    function: {
        name: 'find_references',
        description: 'Find usages of a symbol across source files using regex heuristics. Returns path:line: match lines.',
        parameters: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name to find references for.' },
                directory_path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' },
            },
            required: ['symbol'],
        },
    },
};
export const diagnosticsTool = {
    type: 'function',
    function: {
        name: 'diagnostics',
        description: 'Run `tsc --noEmit` when the directory has a tsconfig.json and return the first errors. ' +
            'Falls back to a clear message when no tsconfig or compiler is available.',
        parameters: {
            type: 'object',
            properties: {
                directory_path: { type: 'string', description: 'Project directory. Defaults to the working directory.' },
            },
            required: [],
        },
    },
};
function cap(text) {
    return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n… output truncated …`;
}
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function resolveDir(dir) {
    const requested = typeof dir === 'string' && dir.trim() ? dir : '.';
    return path.resolve(process.cwd(), requested);
}
async function collectHits(root, matches) {
    const hits = [];
    async function walk(dir) {
        if (hits.length >= MAX_HITS)
            return;
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (hits.length >= MAX_HITS)
                return;
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.'))
                    continue;
                await walk(full);
                continue;
            }
            if (!entry.isFile() || !SOURCE_EXTS.has(path.extname(entry.name).toLowerCase()))
                continue;
            try {
                const stat = await fs.stat(full);
                if (stat.size > MAX_FILE_BYTES)
                    continue;
                const content = await fs.readFile(full, 'utf8');
                if (content.includes('\0'))
                    continue;
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
                    if (!matches(lines[i]))
                        continue;
                    let text = lines[i].trim();
                    if (text.length > 300)
                        text = `${text.slice(0, 300)}...`;
                    hits.push({ display: path.relative(root, full).split(path.sep).join('/'), line: i + 1, text });
                }
            }
            catch {
                // Skip unreadable files.
            }
        }
    }
    await walk(root);
    return hits;
}
function formatHits(kind, name, hits) {
    if (hits.length === 0)
        return `No ${kind} found for "${name}".`;
    const body = hits.map((hit) => `  ${hit.display}:${hit.line}: ${hit.text}`).join('\n');
    const suffix = hits.length >= MAX_HITS ? `\n(results truncated at ${MAX_HITS})` : '';
    return `Found ${hits.length} ${kind} for "${name}":\n${body}${suffix}`;
}
export async function goToDefinition(symbol, dir = '.') {
    if (!validQuery(symbol))
        return 'Error: symbol is required.';
    const name = symbol.trim();
    if (name.length > 200)
        return 'Error: symbol is too long (max 200 characters).';
    try {
        const declaration = new RegExp(`\\b(?:function|class|interface|type|enum|const|let|var|def)\\s+${escapeRegex(name)}\\b`);
        const hits = await collectHits(resolveDir(dir), (line) => declaration.test(line));
        return cap(formatHits('definition(s)', name, hits));
    }
    catch (err) {
        return `Error: go_to_definition failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}
export async function findReferences(symbol, dir = '.') {
    if (!validQuery(symbol))
        return 'Error: symbol is required.';
    const name = symbol.trim();
    if (name.length > 200)
        return 'Error: symbol is too long (max 200 characters).';
    try {
        const reference = new RegExp(`\\b${escapeRegex(name)}\\b`);
        const hits = await collectHits(resolveDir(dir), (line) => reference.test(line));
        return cap(formatHits('reference(s)', name, hits));
    }
    catch (err) {
        return `Error: find_references failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}
function runTsc(command, tsconfig, cwd) {
    return new Promise((resolve) => {
        let output = '';
        let settled = false;
        const state = {};
        const finish = (text) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(state.timer);
            resolve(cap(text));
        };
        let child;
        try {
            child = spawn(command, ['--noEmit', '-p', tsconfig], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            finish(`Error: could not run tsc: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        state.timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch { /* already exited */ }
            finish('Error: tsc timed out after 30 s.');
        }, 30_000);
        child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
        child.on('error', (err) => finish(`Error: could not run tsc: ${err.message}`));
        child.on('close', (code) => {
            const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines.length === 0) {
                finish(code === 0 ? 'No TypeScript diagnostics found.' : `tsc exited with code ${code} (no output).`);
                return;
            }
            const first = lines.slice(0, MAX_DIAGNOSTIC_LINES);
            const suffix = lines.length > first.length ? `\n(first ${first.length} of ${lines.length} lines)` : '';
            finish(`tsc (exit ${code}) diagnostics:\n${first.join('\n')}${suffix}`);
        });
    });
}
export async function diagnostics(dir = '.') {
    const root = resolveDir(dir);
    const tsconfig = path.join(root, 'tsconfig.json');
    if (!existsSync(tsconfig)) {
        return `No tsconfig.json found in ${root}; diagnostics skipped.`;
    }
    try {
        const localTsc = path.join(process.cwd(), 'node_modules', '.bin', 'tsc');
        const command = existsSync(localTsc) ? localTsc : 'tsc';
        return await runTsc(command, tsconfig, root);
    }
    catch (err) {
        return `Error: diagnostics failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

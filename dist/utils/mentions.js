/**
 * mentions.ts — `@path` completion for the composer.
 *
 * The token under the cursor is completed against the filesystem, one level at a
 * time: `@src/` lists `src/`, `@src/ap` suggests `src/app.ts`. The walk is
 * bounded and skips the directories that would make it slow (`node_modules`,
 * `.git`, build output), and it never leaves the workspace root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
export const SKIP_DIRECTORIES = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
    'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__',
]);
const MAX_ENTRIES = 400;
const MAX_SEARCH_DEPTH = 3;
const MAX_SEARCH_ENTRIES = 600;
/** Locate the `@…` token that the cursor is inside, if any. */
export function findMentionToken(text, cursor) {
    const position = Math.max(0, Math.min(cursor, text.length));
    let start = -1;
    for (let index = position - 1; index >= 0; index--) {
        const char = text[index];
        if (char === '@') {
            // `@` must start a token: beginning of input or after whitespace.
            if (index === 0 || /\s/.test(text[index - 1] ?? ''))
                start = index;
            break;
        }
        if (/\s/.test(char ?? ''))
            break;
    }
    if (start < 0)
        return null;
    const token = text.slice(start + 1, position);
    if (token.length > 300)
        return null;
    return { token, start, end: position };
}
/**
 * Candidates for a mention token. Directories are suffixed with `/` so a second
 * Tab descends into them.
 */
export async function listMentionCandidates(cwd, token, limit = 20) {
    const normalized = token.replace(/^\.\//, '');
    const slash = normalized.lastIndexOf('/');
    const directoryPart = slash >= 0 ? normalized.slice(0, slash + 1) : '';
    const prefix = (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
    const root = path.resolve(cwd);
    const directory = path.resolve(root, directoryPart || '.');
    // Never escape the workspace.
    if (directory !== root && !directory.startsWith(root + path.sep))
        return [];
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const matches = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.') && !prefix.startsWith('.'))
            continue;
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name))
            continue;
        if (prefix && !entry.name.toLowerCase().startsWith(prefix))
            continue;
        matches.push(`${directoryPart}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (matches.length >= Math.max(MAX_ENTRIES, limit))
            break;
    }
    matches.sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    return matches.slice(0, limit);
}
function isSubsequence(needle, haystack) {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index])
            index++;
        if (index === needle.length)
            return true;
    }
    return needle.length === 0;
}
function scoreMentionMatch(name, relativePath, query) {
    const lowerName = name.toLowerCase();
    const lowerPath = relativePath.toLowerCase();
    if (lowerName.startsWith(query))
        return 4;
    if (lowerName.includes(query))
        return 3;
    if (lowerPath.includes(query))
        return 2;
    if (isSubsequence(query, lowerPath))
        return 1;
    return 0;
}
/**
 * Bounded, fuzzy file search for the `@` picker. Empty queries list only the
 * immediate children of `cwd`; non-empty queries rank deeper matches by how
 * well the query fits the base name and relative path.
 */
export async function searchMentionFiles(cwd, query, limit = 30) {
    const root = path.resolve(cwd);
    const normalized = query.trim().replace(/^\.\//, '');
    const lowerQuery = normalized.toLowerCase();
    const allowDot = lowerQuery.startsWith('.');
    const matches = [];
    const cap = Math.max(0, limit);
    const record = (entry, relativeDir, score) => {
        matches.push({
            relativePath: path.join(relativeDir, entry.name).split(path.sep).join('/'),
            isDirectory: entry.isDirectory(),
            name: entry.name,
            score,
        });
    };
    if (!lowerQuery) {
        let entries;
        try {
            entries = await fs.readdir(root, { withFileTypes: true });
        }
        catch {
            return [];
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') && !allowDot)
                continue;
            if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name))
                continue;
            record(entry, '', 0);
        }
        matches.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) ||
            a.relativePath.localeCompare(b.relativePath));
        return matches.slice(0, cap);
    }
    let visited = 0;
    const walk = async (directory, relativeDir, depth) => {
        if (depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_ENTRIES)
            return;
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (visited >= MAX_SEARCH_ENTRIES)
                return;
            visited++;
            if (entry.name.startsWith('.') && !allowDot)
                continue;
            const isDirectory = entry.isDirectory();
            if (isDirectory && SKIP_DIRECTORIES.has(entry.name))
                continue;
            const nextRelative = path.join(relativeDir, entry.name);
            const score = scoreMentionMatch(entry.name, nextRelative.split(path.sep).join('/'), lowerQuery);
            if (score > 0)
                record(entry, relativeDir, score);
            if (isDirectory && depth < MAX_SEARCH_DEPTH) {
                await walk(path.join(directory, entry.name), nextRelative, depth + 1);
            }
        }
    };
    await walk(root, '', 1);
    matches.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
    return matches.slice(0, cap);
}
/** Replace the mention token with a completed value, returning the new cursor. */
export function applyMention(text, token, replacement) {
    const before = text.slice(0, token.start + 1);
    const after = text.slice(token.end);
    const next = `${before}${replacement}${after}`;
    return { text: next, cursor: token.start + 1 + replacement.length };
}
/** Paths mentioned in a prompt, for the `@file` freeze step. */
export function extractMentions(text) {
    const mentions = [];
    for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
        const value = match[2]?.trim();
        if (value && !mentions.includes(value))
            mentions.push(value);
    }
    return mentions;
}

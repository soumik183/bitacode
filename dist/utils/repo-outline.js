/**
 * repo-outline.ts — a cheap, token-budgeted symbol outline of the workspace.
 *
 * A full tree-sitter repo map is a large dependency. This is the 80% version:
 * a bounded walk over source files, a handful of declaration regexes per
 * language, and a compact `path: symbol, symbol` block in the system prompt.
 * Results are cached briefly because the prompt is rebuilt every turn.
 *
 * Everything is best-effort and never throws.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '.turbo',
    'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);
const SYMBOL_PATTERNS = [
    // TypeScript / JavaScript
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    // Python
    /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm,
    // Go
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
    // Rust
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
    // Java / Kotlin / Ruby (class/def)
    /^\s*(?:public|private|protected|internal)?\s*(?:class|interface|object)\s+([A-Za-z_]\w*)/gm,
    /^\s*def\s+([A-Za-z_]\w*[?!]?)/gm,
];
const CACHE_TTL_MS = 15_000;
const cache = new Map();
function isSourceFile(name) {
    return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|cs|swift|c|h|cc|cpp|hpp)$/i.test(name);
}
async function walk(dir, root, depth, maxDepth, budget, out) {
    if (depth > maxDepth || budget.files >= budget.maxFiles)
        return;
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (budget.files >= budget.maxFiles)
            return;
        if (entry.name.startsWith('.') && entry.name !== '.')
            continue;
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name))
                continue;
            await walk(path.join(dir, entry.name), root, depth + 1, maxDepth, budget, out);
            continue;
        }
        if (!entry.isFile() || !isSourceFile(entry.name))
            continue;
        budget.files++;
        const absolute = path.join(dir, entry.name);
        let text;
        try {
            const stat = await fs.stat(absolute);
            if (stat.size > 200_000)
                continue;
            text = await fs.readFile(absolute, 'utf8');
        }
        catch {
            continue;
        }
        const names = new Set();
        for (const pattern of SYMBOL_PATTERNS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null && names.size < 12) {
                names.add(match[1]);
            }
        }
        if (names.size === 0)
            continue;
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        out.push(`${relative}: ${[...names].join(', ')}`);
    }
}
/** Build the outline; returns '' when the workspace has no readable symbols. */
export async function buildRepoOutline(cwd = process.cwd(), options = {}) {
    const root = path.resolve(cwd);
    const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
    const cached = cache.get(root);
    if (ttl > 0 && cached && Date.now() - cached.at < ttl)
        return cached.text;
    const maxFiles = Math.max(1, options.maxFiles ?? 160);
    const maxDepth = Math.max(0, options.maxDepth ?? 3);
    const maxChars = Math.max(200, options.maxChars ?? 4000);
    const lines = [];
    await walk(root, root, 0, maxDepth, { files: 0, maxFiles }, lines);
    let text = '';
    for (const line of lines) {
        if (text.length + line.length + 1 > maxChars)
            break;
        text += `${line}\n`;
    }
    text = text.trim();
    if (ttl > 0)
        cache.set(root, { at: Date.now(), text });
    return text;
}
/** Test helper: drop the outline cache. */
export function resetRepoOutlineCacheForTests() {
    cache.clear();
}

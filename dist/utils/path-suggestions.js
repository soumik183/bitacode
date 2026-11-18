/**
 * Path suggestions utility — Find similar paths when a file isn't found.
 *
 * Used by read_file and edit_file to suggest alternatives when
 * the requested path doesn't exist (helps recover from typos).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import leven from 'leven';
import { getWorkingDirectory } from './path-validation.js';
const MAX_SUGGESTIONS = 3;
const SKIP_ENTRIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
/** Walk up from `start` until an existing directory is found. */
async function nearestExistingDir(start) {
    let current = start;
    for (;;) {
        try {
            const stats = await fs.stat(current);
            if (stats.isDirectory())
                return current;
        }
        catch {
            // Path doesn't exist — keep walking up
        }
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
/**
 * Find similar paths when a requested file doesn't exist.
 *
 * Only the nearest existing directory is inspected, so this stays fast even
 * in large repos and suggests the actual sibling the model probably meant.
 */
export async function findSimilarPaths(requestedPath) {
    const cwd = getWorkingDirectory();
    const absolute = path.resolve(cwd, requestedPath);
    const parent = path.dirname(absolute);
    const searchDir = await nearestExistingDir(parent);
    if (!searchDir)
        return [];
    // If the parent is missing, the typo is in a path segment. Compare the
    // first missing segment against the entries of the nearest existing dir.
    const parentExists = searchDir === parent;
    const relative = path.relative(searchDir, absolute);
    const target = parentExists ? path.basename(absolute) : relative.split(path.sep)[0];
    let entries;
    try {
        entries = await fs.readdir(searchDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const maxDistance = Math.max(2, Math.floor(target.length / 3));
    return entries
        .filter((entry) => !SKIP_ENTRIES.has(entry.name))
        .map((entry) => ({
        path: path.relative(cwd, path.join(searchDir, entry.name)).split(path.sep).join('/'),
        distance: leven(target.toLowerCase(), entry.name.toLowerCase()),
    }))
        .filter((entry) => entry.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_SUGGESTIONS)
        .map((entry) => entry.path);
}

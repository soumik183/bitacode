/**
 * Path validation utility shared by all file tools.
 *
 * Ensures that every file path the agent operates on is within the
 * working directory (process.cwd()). Prevents directory traversal
 * and symlink escape attacks.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

let allowedRoots: string[] = [];

/**
 * Read the cwd on every check. It used to be captured once at module load, so a
 * later chdir (tests, resumed sessions) kept validating against a stale root.
 */
function workingDirectory(): string {
  return process.cwd();
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedPath(targetPath: string): boolean {
  return isWithinRoot(targetPath, workingDirectory()) || allowedRoots.some((root) => isWithinRoot(targetPath, root));
}

export async function setAllowedPathRoots(roots: string[]): Promise<void> {
  const normalizedRoots = await Promise.all(
    roots.map(async (root) => {
      const resolved = path.resolve(root);
      try {
        const realRoot = await fs.realpath(resolved);
        return [path.normalize(resolved), realRoot];
      } catch {
        return [path.normalize(resolved)];
      }
    })
  );

  allowedRoots = Array.from(new Set(normalizedRoots.flat()));
}

export function getAllowedPathRoots(): string[] {
  return [...allowedRoots];
}

/**
 * Resolve and validate a path. Throws if the path is outside cwd.
 *
 * Paths that don't exist yet are allowed: the deepest existing ancestor is
 * resolved and validated, and the remaining components are appended as-is.
 * Anything below that ancestor will be created by the caller, so it cannot
 * be a symlink escaping the working directory.
 */
export async function validatePath(requestedPath: string): Promise<string> {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('A file path is required.');
  }
  if (requestedPath.includes('\0')) {
    throw new Error('Path contains a null byte.');
  }

  // First check: is the normalised path within cwd?
  const normalized = path.normalize(path.resolve(workingDirectory(), requestedPath));
  if (!isAllowedPath(normalized)) {
    throw new Error(`Path "${requestedPath}" is outside the working directory.`);
  }

  // Second check: resolve symlinks on the deepest existing ancestor and re-check
  let current = normalized;
  const missing: string[] = [];

  for (;;) {
    try {
      const realPath = await fs.realpath(current);
      if (!isAllowedPath(realPath)) {
        throw new Error(`Path "${requestedPath}" resolves (via symlink) outside the working directory.`);
      }
      return path.join(realPath, ...missing.reverse());
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error(`Path "${requestedPath}" does not exist.`);
        }
        missing.push(path.basename(current));
        current = parent;
        continue;
      }
      if (err.code === 'ENOTDIR') {
        throw new Error(`Path "${requestedPath}" is invalid: a parent is not a directory.`);
      }
      throw err;
    }
  }
}

export function getWorkingDirectory(): string {
  return workingDirectory();
}

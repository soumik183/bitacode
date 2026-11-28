/**
 * protected-paths.ts — paths the agent must never write, regardless of mode.
 *
 * Sandboxing is out of scope for a portable TUI, but a few directories are
 * effectively the machine's control plane and should not be silently rewritten:
 * git internals, credentials, and bitacode's own trust/config store. Reads stay
 * allowed; only mutations are refused.
 */

import path from 'node:path';

const PROTECTED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.aws',
  '.ssh',
  '.gnupg',
  '.bitacode',
  '.agents',
]);

/**
 * True when `absolutePath` resolves inside a protected directory relative to
 * `cwd`. Paths outside `cwd` are not this function's concern (validatePath
 * already rejects them).
 */
export function isProtectedPath(absolutePath: string, cwd = process.cwd()): boolean {
  const root = path.resolve(cwd);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return Boolean(first) && PROTECTED_DIRS.has(first.toLowerCase());
}

/** Throwing variant for mutating tools. */
export function assertWritablePath(absolutePath: string, cwd = process.cwd()): void {
  if (isProtectedPath(absolutePath, cwd)) {
    const relative = path.relative(path.resolve(cwd), path.resolve(absolutePath));
    throw new Error(
      `"${relative}" is in a protected location and cannot be modified by the agent. ` +
      'Edit it yourself, or move it outside the protected directory first.',
    );
  }
}

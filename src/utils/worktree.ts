/**
 * Per-task git worktree sandboxes for bitacode.
 *
 * Every task gets an isolated worktree below `<repo>/.bitacode/worktrees/<name>`
 * on a `bitacode/<name>` branch. Names are validated and resolved paths are
 * checked for symlink escapes before any git command runs. All failures are
 * returned as `WorktreeResult` error values rather than thrown to callers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** Metadata for one bitacode worktree. */
export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  createdAt: string;
}

/** Explicit success/failure envelope used by every async operation here. */
export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface Options {
  cwd?: string;
}

interface CreateOptions extends Options {
  baseRef?: string;
}

interface RemoveOptions extends Options {
  force?: boolean;
}

interface VerifiedPaths {
  repo: string;
  home: string;
  target: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const BRANCH_PREFIX = 'bitacode/';
const WORKTREE_MARKER = '/.bitacode/worktrees/';
const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

/** Names that are awkward or invalid as directory names on common platforms. */
const RESERVED_NAMES = new Set<string>([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function resolveCwd(cwd?: string): string {
  const base = typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
  return path.resolve(base);
}

/** Absolute path of the directory that holds all bitacode worktrees. */
export function worktreeHome(cwd?: string): string {
  return path.join(resolveCwd(cwd), '.bitacode', 'worktrees');
}

/** True when `target` is `root` itself or sits below it. */
function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

/**
 * Validate a worktree name before it reaches the filesystem or git.
 * Kept internal so the public surface stays exactly the documented API.
 */
function isValidWorktreeName(name: unknown): name is string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return false;
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return false;
  if (RESERVED_NAMES.has(name.toLowerCase())) return false;
  return true;
}

function failed(error: unknown, fallback: string): WorktreeResult<never> {
  let message = '';
  if (error instanceof Error) message = error.message.trim();
  if (!message) message = String(error ?? '').trim();
  return { ok: false, error: message || fallback };
}

/**
 * Run git without a shell. The rejection message is the trimmed stderr from
 * git (with the Node error message as a fallback), so callers can include it.
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim()
            || String((error as Error).message ?? '').trim()
            || 'git command failed';
          reject(new Error(detail));
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

/** First git call for every operation: make sure we are in a work tree. */
async function assertGitRepo(cwd: string): Promise<void> {
  const output = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (output.trim() !== 'true') {
    throw new Error('directory is not inside a git work tree');
  }
}

/**
 * Resolve `p` to an absolute path, following symlinks on its deepest existing
 * ancestor but keeping nonexistent segments. Rejects anything that resolves
 * outside the (already canonicalised) repository root.
 */
async function verifiedRealPath(p: string, repoReal: string): Promise<string> {
  let current = p;
  const tail: string[] = [];

  for (;;) {
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        tail.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
        continue;
      }
      if (code === 'ENOTDIR') {
        throw new Error(`invalid worktree path: a parent of ${p} is not a directory`);
      }
      throw error;
    }
    if (!isWithin(real, repoReal)) {
      throw new Error('worktree path escapes the repository via a symlink');
    }
    return path.join(real, ...tail);
  }

  throw new Error(`unable to resolve worktree path: ${p}`);
}

/**
 * Validate a name and verify its prospective directory before any git call.
 * The lexical paths are returned so git -- and our results -- use stable,
 * human-readable locations; only the containment checks use realpaths.
 */
async function verifyPaths(cwd: string | undefined, name: unknown): Promise<VerifiedPaths> {
  if (!isValidWorktreeName(name)) {
    throw new Error(`invalid worktree name "${String(name)}"`);
  }
  const repo = resolveCwd(cwd);
  const home = worktreeHome(repo);
  const target = path.join(home, name);
  if (!isWithin(target, repo)) {
    throw new Error('worktree path escapes the repository');
  }

  let repoReal: string;
  try {
    repoReal = await fs.realpath(repo);
  } catch {
    throw new Error(`repository directory does not exist: ${repo}`);
  }
  await verifiedRealPath(home, repoReal);
  await verifiedRealPath(target, repoReal);

  return { repo, home, target };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Remove a directory left behind by a failed `git worktree add`, but only if empty. */
async function removeEmptyDir(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(target);
    if (entries.length === 0) await fs.rmdir(target);
  } catch {
    // Best effort: never mask the original failure.
  }
}

async function creationTime(p: string): Promise<string> {
  try {
    const stat = await fs.stat(p);
    const date = stat.birthtime.getTime() > 0 ? stat.birthtime : stat.mtime;
    return date.toISOString();
  } catch {
    return '';
  }
}

/** Create a worktree named `name` on a dedicated `bitacode/<name>` branch. */
export async function createWorktree(
  name: string,
  options: CreateOptions = {},
): Promise<WorktreeResult<WorktreeInfo>> {
  try {
    const { repo, home, target } = await verifyPaths(options.cwd, name);
    await assertGitRepo(repo);

    await fs.mkdir(home, { recursive: true });
    if (await pathExists(target)) {
      return { ok: false, error: `worktree "${name}" already exists at ${target}` };
    }

    const branch = `${BRANCH_PREFIX}${name}`;
    const addArgs = ['worktree', 'add', '-b', branch, target];
    if (typeof options.baseRef === 'string' && options.baseRef.trim()) {
      addArgs.push(options.baseRef.trim());
    }

    try {
      await runGit(repo, addArgs);
    } catch (error) {
      const message = failed(error, 'git worktree add failed').error;
      // A leftover branch is reusable: check it out instead of recreating it.
      if (/already exists/i.test(message) && /branch/i.test(message)) {
        await removeEmptyDir(target);
        try {
          await runGit(repo, ['worktree', 'add', target, branch]);
        } catch (retryError) {
          await removeEmptyDir(target);
          return failed(retryError, `failed to create worktree "${name}"`);
        }
      } else {
        await removeEmptyDir(target);
        return { ok: false, error: `failed to create worktree "${name}": ${message}` };
      }
    }

    return {
      ok: true,
      value: { name, path: target, branch, createdAt: new Date().toISOString() },
    };
  } catch (error) {
    return failed(error, 'failed to create worktree');
  }
}

/**
 * Parse `git worktree list --porcelain` into our worktree entries.
 *
 * Pure and tolerant: unknown/missing fields are ignored, blank lines separate
 * blocks, and only paths containing `/.bitacode/worktrees/<name>` are returned.
 * `createdAt` is left empty here; `listWorktrees` fills it from the filesystem.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  if (typeof output !== 'string' || output.trim() === '') return [];

  const result: WorktreeInfo[] = [];
  const blocks = output.replace(/\r\n?/g, '\n').split(/\n\s*\n/);

  for (const block of blocks) {
    let worktreePath = '';
    let branch = '';

    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('worktree ')) {
        worktreePath = trimmed.slice('worktree '.length).trim();
      } else if (trimmed.startsWith('branch ')) {
        branch = trimmed.slice('branch '.length).trim();
      }
      // HEAD, detached, locked, prunable and unknown keys are all ignored.
    }
    if (!worktreePath) continue;

    const normalized = worktreePath.replace(/\\/g, '/');
    const markerIndex = normalized.lastIndexOf(WORKTREE_MARKER);
    if (markerIndex === -1) continue;

    const name = normalized.slice(markerIndex + WORKTREE_MARKER.length).replace(/\/+$/, '');
    if (!isValidWorktreeName(name)) continue;

    result.push({
      name,
      path: worktreePath,
      branch: branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch,
      createdAt: '',
    });
  }

  return result;
}

/** List our worktrees, with creation times read from their directories. */
export async function listWorktrees(cwd?: string): Promise<WorktreeResult<WorktreeInfo[]>> {
  try {
    const repo = resolveCwd(cwd);
    const repoReal = await fs.realpath(repo);
    await assertGitRepo(repo);

    const output = await runGit(repo, ['worktree', 'list', '--porcelain']);
    const home = worktreeHome(repo);
    const realHome = await verifiedRealPath(home, repoReal).catch(() => home);

    const entries = parseWorktreeList(output).filter((info) => {
      const absolute = path.resolve(info.path);
      return isWithin(absolute, home) || isWithin(absolute, realHome);
    });
    const value = await Promise.all(entries.map(async (info) => ({
      ...info,
      createdAt: await creationTime(info.path),
    })));

    return { ok: true, value };
  } catch (error) {
    return failed(error, 'failed to list worktrees');
  }
}

/** Remove a worktree and then best-effort delete its dedicated branch. */
export async function removeWorktree(
  name: string,
  options: RemoveOptions = {},
): Promise<WorktreeResult<void>> {
  try {
    const { repo, target } = await verifyPaths(options.cwd, name);
    await assertGitRepo(repo);

    const output = await runGit(repo, ['worktree', 'list', '--porcelain']);
    if (!parseWorktreeList(output).some((info) => info.name === name)) {
      return { ok: false, error: `unknown worktree "${name}"` };
    }

    const removeArgs = ['worktree', 'remove'];
    if (options.force) removeArgs.push('--force');
    removeArgs.push(target);
    await runGit(repo, removeArgs);

    // The branch is bookkeeping only: a failed delete must not fail the removal.
    try {
      await runGit(repo, ['branch', '-D', `${BRANCH_PREFIX}${name}`]);
    } catch {
      // Best effort.
    }

    return { ok: true, value: undefined };
  } catch (error) {
    return failed(error, 'failed to remove worktree');
  }
}

/**
 * repo-context.ts — a small snapshot of the workspace, injected once per task.
 *
 * The model otherwise spends its first tool calls discovering the same facts:
 * what branch this is, what is dirty, which scripts exist. Collecting them up
 * front is cheap (three git calls plus two small file reads) and it is injected
 * as a *volatile* frame, never into the static system prompt, so the provider's
 * prefix cache still hits across turns.
 *
 * Everything is best-effort and time-boxed: a repo without git, or a git that
 * hangs, yields a smaller frame rather than a failed turn.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface RepoContext {
  cwd: string;
  branch?: string;
  headLine?: string;
  statusLines: string[];
  diffStat: string[];
  directories: string[];
  files: string[];
  packageName?: string;
  scripts: Record<string, string>;
  /** Set when the directory is not a git work tree. */
  notGit?: boolean;
}

export interface CollectOptions {
  cwd: string;
  /** Milliseconds per git invocation. */
  timeoutMs?: number;
  /** Cap on each list, so a huge monorepo cannot blow the frame budget. */
  maxEntries?: number;
  /** Injected for tests. */
  execFileFn?: typeof execFile;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, execFileFn: typeof execFile): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFileFn(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout) => {
        if (err) resolve('');
        else resolve(String(stdout ?? ''));
      });
    } catch {
      resolve('');
    }
  });
}

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Collect the snapshot. Never throws. */
export async function collectRepoContext(options: CollectOptions): Promise<RepoContext> {
  const cwd = path.resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? 1_500;
  const maxEntries = options.maxEntries ?? 24;
  const execFileFn = options.execFileFn ?? execFile;

  const [branch, status, diffStat, topLevel] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutMs, execFileFn),
    run('git', ['status', '--short', '--untracked-files=normal'], cwd, timeoutMs, execFileFn),
    run('git', ['diff', '--stat', '--no-color'], cwd, timeoutMs, execFileFn),
    fs.readdir(cwd).catch(() => [] as string[]),
  ]);

  const context: RepoContext = {
    cwd,
    statusLines: splitLines(status).slice(0, maxEntries),
    diffStat: splitLines(diffStat).slice(-Math.min(maxEntries, 12)),
    directories: [],
    files: [],
    scripts: {},
  };

  const branchName = branch.trim();
  if (branchName) context.branch = branchName;
  else context.notGit = true;

  for (const entry of topLevel) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(path.join(cwd, entry))).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) context.directories.push(`${entry}/`);
    else context.files.push(entry);
    if (context.directories.length + context.files.length >= maxEntries) break;
  }

  const pkg = await readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    if (typeof pkg.name === 'string') context.packageName = pkg.name;
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [name, value] of Object.entries(pkg.scripts as Record<string, unknown>)) {
        if (typeof value === 'string') context.scripts[name] = value;
      }
    }
  }

  return context;
}

/** Render the snapshot as a compact frame. Returns '' when there is nothing to say. */
export function renderRepoContext(context: RepoContext, maxChars = 2_000): string {
  const lines: string[] = [];
  if (context.branch) lines.push(`branch: ${context.branch}`);
  else if (context.notGit) lines.push('not a git work tree');

  if (context.statusLines.length > 0) {
    lines.push('changed files:');
    for (const line of context.statusLines) lines.push(`  ${line}`);
  } else if (!context.notGit) {
    lines.push('working tree clean');
  }

  if (context.diffStat.length > 0) {
    lines.push('diff stat:');
    for (const line of context.diffStat) lines.push(`  ${line}`);
  }

  if (context.directories.length > 0) lines.push(`directories: ${context.directories.join(' ')}`);
  if (context.files.length > 0) lines.push(`files: ${context.files.join(' ')}`);

  const scriptNames = Object.keys(context.scripts);
  if (scriptNames.length > 0) {
    lines.push(`scripts: ${scriptNames.map((name) => `${name}${name === 'test' ? ' (default check)' : ''}`).join(', ')}`);
  }

  if (lines.length === 0) return '';
  const body = lines.join('\n');
  const text = [
    'Workspace snapshot (captured when this task started; re-check with tools if it matters):',
    body,
  ].join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[snapshot truncated]`;
}

/** One-line summary for the status line. */
export function summarizeRepoContext(context: RepoContext): string {
  const branch = context.branch ?? 'no-git';
  const dirty = context.statusLines.length;
  return dirty > 0 ? `${branch} · ${dirty} changed` : `${branch} · clean`;
}

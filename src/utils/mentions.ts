/**
 * mentions.ts — `@path` completion for the composer.
 *
 * The token under the cursor is completed against the filesystem, one level at a
 * time: `@src/` lists `src/`, `@src/ap` suggests `src/app.ts`. The walk is
 * bounded and skips the directories that would make it slow (`node_modules`,
 * `.git`, build output), and it never leaves the workspace root.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export interface MentionToken {
  /** Text after `@`, without the `@`. */
  token: string;
  /** Index of the `@`. */
  start: number;
  /** Cursor position, i.e. one past the token. */
  end: number;
}

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__',
]);

const MAX_ENTRIES = 400;

/** Locate the `@…` token that the cursor is inside, if any. */
export function findMentionToken(text: string, cursor: number): MentionToken | null {
  const position = Math.max(0, Math.min(cursor, text.length));
  let start = -1;
  for (let index = position - 1; index >= 0; index--) {
    const char = text[index];
    if (char === '@') {
      // `@` must start a token: beginning of input or after whitespace.
      if (index === 0 || /\s/.test(text[index - 1] ?? '')) start = index;
      break;
    }
    if (/\s/.test(char ?? '')) break;
  }
  if (start < 0) return null;
  const token = text.slice(start + 1, position);
  if (token.length > 300) return null;
  return { token, start, end: position };
}

/**
 * Candidates for a mention token. Directories are suffixed with `/` so a second
 * Tab descends into them.
 */
export async function listMentionCandidates(
  cwd: string,
  token: string,
  limit = 20,
): Promise<string[]> {
  const normalized = token.replace(/^\.\//, '');
  const slash = normalized.lastIndexOf('/');
  const directoryPart = slash >= 0 ? normalized.slice(0, slash + 1) : '';
  const prefix = (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();

  const root = path.resolve(cwd);
  const directory = path.resolve(root, directoryPart || '.');
  // Never escape the workspace.
  if (directory !== root && !directory.startsWith(root + path.sep)) return [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;
    matches.push(`${directoryPart}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (matches.length >= Math.max(MAX_ENTRIES, limit)) break;
  }
  matches.sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
  return matches.slice(0, limit);
}

/** Replace the mention token with a completed value, returning the new cursor. */
export function applyMention(
  text: string,
  token: MentionToken,
  replacement: string,
): { text: string; cursor: number } {
  const before = text.slice(0, token.start + 1);
  const after = text.slice(token.end);
  const next = `${before}${replacement}${after}`;
  return { text: next, cursor: token.start + 1 + replacement.length };
}

/** Paths mentioned in a prompt, for the `@file` freeze step. */
export function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const value = match[2]?.trim();
    if (value && !mentions.includes(value)) mentions.push(value);
  }
  return mentions;
}

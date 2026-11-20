/**
 * input-history.ts — prompt history for the composer.
 *
 * Up/Down on a single-line draft walks previous prompts, and the draft the user
 * was typing is preserved as the newest entry (so Up then Down gets it back).
 * Consecutive duplicates are collapsed, the file is capped, and a torn or
 * unreadable history never blocks startup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_HISTORY_ENTRIES = 300;
const MAX_ENTRY_CHARS = 8_000;

export function historyFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'bitacode', 'history.jsonl');
}

function normalize(entry: string): string {
  return entry.replace(/\r\n/g, '\n').trim();
}

export function loadHistory(file = historyFilePath()): string[] {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { text?: unknown };
      if (typeof parsed.text === 'string') {
        const value = normalize(parsed.text);
        if (value) entries.push(value.slice(0, MAX_ENTRY_CHARS));
      }
    } catch {
      // Ignore torn lines.
    }
  }
  return entries.slice(-MAX_HISTORY_ENTRIES);
}

/** Append one entry (skipping immediate duplicates) and return the new list. */
export function appendHistory(entry: string, options: { file?: string; limit?: number } = {}): string[] {
  const text = normalize(entry).slice(0, MAX_ENTRY_CHARS);
  if (!text) return loadHistory(options.file);
  const limit = options.limit ?? MAX_HISTORY_ENTRIES;
  const file = options.file ?? historyFilePath();
  const entries = loadHistory(file);
  if (entries[entries.length - 1] === text) return entries;

  entries.push(text);
  const trimmed = entries.slice(-limit);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, trimmed.map((value) => JSON.stringify({ text: value })).join('\n') + '\n', { mode: 0o600 });
  } catch {
    // History is a convenience; never fail a turn because of it.
  }
  return trimmed;
}

/**
 * Cursor over history for the composer.
 *
 * `index` counts from the newest entry backwards: 0 is the most recent prompt,
 * -1 means "back to the draft".
 */
export class HistoryNavigator {
  private readonly entries: string[];
  private index = -1;
  private draft = '';

  constructor(entries: readonly string[]) {
    this.entries = [...entries];
  }

  /** Replace the entry list (e.g. after saving a session). */
  replace(entries: readonly string[]): void {
    this.entries.length = 0;
    this.entries.push(...entries);
    this.index = -1;
  }

  /** Remember what the user was typing before they started walking history. */
  rememberDraft(draft: string): void {
    if (this.index === -1) this.draft = draft;
  }

  get size(): number {
    return this.entries.length;
  }

  get position(): number {
    return this.index;
  }

  /** Older entry, or null at the oldest one. */
  up(): string | null {
    if (this.entries.length === 0) return null;
    if (this.index + 1 >= this.entries.length) return null;
    this.index++;
    return this.entries[this.entries.length - 1 - this.index] ?? null;
  }

  /** Newer entry; returns the original draft when walking past the newest. */
  down(): string | null {
    if (this.index < 0) return null;
    this.index--;
    if (this.index < 0) return this.draft;
    return this.entries[this.entries.length - 1 - this.index] ?? this.draft;
  }

  reset(): void {
    this.index = -1;
  }

  /** Current draft preserved by the navigator. */
  get currentDraft(): string {
    return this.draft;
  }
}
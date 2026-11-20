/**
 * memory.ts — small, durable, cross-session memory of the user's conventions.
 *
 * Entries are typed so recall can be filtered: a `constraint` ("never touch
 * migrations") should outrank a `note` ("prefers pnpm"). Storage is an append-only
 * JSONL file under the data directory, read tolerantly: a torn last line from a
 * crash must never block startup.
 *
 * Memory is injected as a *volatile* frame when non-empty, capped hard, and is
 * never written by the model without an explicit `memory_add` call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'constraint', 'todo', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  id: string;
  ts: string;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  /** Where it came from: `user`, `tool`, `import`. */
  source?: string;
}

export interface MemoryFilter {
  kind?: MemoryKind;
  query?: string;
  limit?: number;
}

/** Bound on how much memory text enters a prompt. */
export const MAX_MEMORY_FRAME_CHARS = 2_000;
const MAX_ENTRY_CHARS = 600;
const MAX_ENTRIES = 500;

function dataDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode');
}

export function memoryFilePath(): string {
  return path.join(dataDir(), 'memory.jsonl');
}

function isKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

function makeId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Keep one line per entry: collapse newlines so JSONL stays line-safe. */
function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, MAX_ENTRY_CHARS);
}

export function readMemoryEntries(file = memoryFilePath()): { entries: MemoryEntry[]; errors: string[] } {
  const entries: MemoryEntry[] = [];
  const errors: string[] = [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') errors.push(`could not read memory: ${String(err)}`);
    return { entries, errors };
  }

  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryEntry>;
      if (!parsed || typeof parsed.text !== 'string' || !isKind(parsed.kind)) {
        errors.push(`memory line ${index + 1} ignored: missing kind or text`);
        continue;
      }
      entries.push({
        id: typeof parsed.id === 'string' ? parsed.id : makeId(),
        ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
        kind: parsed.kind,
        text: normalizeText(parsed.text),
        ...(Array.isArray(parsed.tags) ? { tags: parsed.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
        ...(typeof parsed.source === 'string' ? { source: parsed.source } : {}),
      });
    } catch {
      // A torn line is expected after a crash; skip it silently.
      errors.push(`memory line ${index + 1} ignored: not JSON`);
    }
  }
  return { entries, errors };
}

export function addMemory(input: {
  kind?: string;
  text: string;
  tags?: string[];
  source?: string;
  file?: string;
}): MemoryEntry | { error: string } {
  const kind: MemoryKind = isKind(input.kind) ? input.kind : 'note';
  const text = normalizeText(input.text ?? '');
  if (!text) return { error: 'memory text is empty' };

  const { entries } = readMemoryEntries(input.file);
  const duplicate = entries.find((entry) => entry.kind === kind && entry.text.toLowerCase() === text.toLowerCase());
  if (duplicate) return duplicate;

  const entry: MemoryEntry = {
    id: makeId(),
    ts: new Date().toISOString(),
    kind,
    text,
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags.filter(Boolean) } : {}),
    ...(input.source ? { source: input.source } : {}),
  };

  const file = input.file ?? memoryFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn('Could not append memory entry', { file, error: String(err) });
    return { error: `could not save memory: ${String(err instanceof Error ? err.message : err)}` };
  }

  // Trim only rarely, and only at write time, so reads stay cheap.
  if (entries.length + 1 > MAX_ENTRIES) {
    const keep = entries.slice(entries.length + 1 - MAX_ENTRIES);
    try {
      const body = [...keep, entry].map((item) => JSON.stringify(item)).join('\n');
      fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
    } catch {
      // Trimming is optional; the append already succeeded.
    }
  }
  return entry;
}

export function listMemory(filter: MemoryFilter = {}, file?: string): MemoryEntry[] {
  const { entries } = readMemoryEntries(file);
  const query = filter.query?.trim().toLowerCase();
  const matched = entries.filter((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (!query) return true;
    const haystack = `${entry.text} ${(entry.tags ?? []).join(' ')} ${entry.kind}`.toLowerCase();
    return haystack.includes(query);
  });
  const limit = filter.limit ?? 50;
  return matched.slice(-limit);
}

/** Remove by exact id, or by case-insensitive substring; returns removed count. */
export function forgetMemory(idOrText: string, file?: string): number {
  const target = idOrText.trim();
  if (!target) return 0;
  const { entries } = readMemoryEntries(file);
  const needle = target.toLowerCase();
  const keep = entries.filter((entry) => entry.id !== target && !entry.text.toLowerCase().includes(needle));
  const removed = entries.length - keep.length;
  if (removed === 0) return 0;
  const path_ = file ?? memoryFilePath();
  try {
    const body = keep.map((entry) => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(path_, body ? `${body}\n` : '', { mode: 0o600 });
  } catch (err) {
    logger.warn('Could not rewrite memory file', { file: path_, error: String(err) });
    return 0;
  }
  return removed;
}

/**
 * Render memory for the prompt. Constraints come first because they are the
 * entries that cost the most when ignored.
 */
export function memoryFrame(file?: string, maxChars = MAX_MEMORY_FRAME_CHARS): string {
  const entries = listMemory({ limit: 60 }, file);
  if (entries.length === 0) return '';
  const order: MemoryKind[] = ['constraint', 'decision', 'preference', 'fact', 'todo', 'note'];
  const sorted = [...entries].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  const lines: string[] = ['Saved memory about this user and project (respect it unless told otherwise):'];
  for (const entry of sorted) {
    const line = `- [${entry.kind}] ${entry.text}`;
    if (lines.join('\n').length + line.length > maxChars) {
      lines.push('…[more memory available; ask or run /memory list]');
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function formatMemoryList(entries: readonly MemoryEntry[]): string[] {
  if (entries.length === 0) return ['memory is empty'];
  return entries.map((entry) => `${entry.id}  ${entry.ts.slice(0, 10)}  [${entry.kind}] ${entry.text}`);
}

export function clearMemory(file?: string): void {
  const path_ = file ?? memoryFilePath();
  try {
    fs.writeFileSync(path_, '', { mode: 0o600 });
  } catch (err) {
    logger.warn('Could not clear memory', { file: path_, error: String(err) });
  }
}

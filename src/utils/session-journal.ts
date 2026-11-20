/**
 * session-journal.ts — append-only JSONL log of a session's turns.
 *
 * The session store keeps the model-visible message array, which has to be
 * rewritten as a unit when history is compacted. The journal is the opposite:
 * one line per event, never rewritten, so a crash loses at most one line and the
 * file can be tailed while the agent runs.
 *
 * Readers are tolerant by design — a torn final line is expected after a crash
 * and is skipped rather than treated as corruption.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type JournalLineType =
  | 'session_start'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'compaction'
  | 'checkpoint'
  | 'usage'
  | 'session_end';

export interface JournalLine {
  type: JournalLineType;
  ts: string;
  content?: string;
  data?: Record<string, unknown>;
}

export interface JournalStats {
  lines: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  toolErrors: number;
  compactions: number;
  startedAt?: string;
  endedAt?: string;
  bytes: number;
}

export function journalDirectory(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode', 'journal');
}

export function journalPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(journalDirectory(), `${safe}.jsonl`);
}

/** Append one line. Never throws: journaling must not fail a turn. */
export function appendJournal(sessionId: string, line: Omit<JournalLine, 'ts'> & { ts?: string }): boolean {
  if (!sessionId) return false;
  const target = journalPath(sessionId);
  const payload: JournalLine = {
    type: line.type,
    ts: line.ts ?? new Date().toISOString(),
    ...(line.content !== undefined ? { content: line.content } : {}),
    ...(line.data !== undefined ? { data: line.data } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Read a journal, skipping lines that do not parse. */
export function readJournal(sessionId: string): { lines: JournalLine[]; skipped: number } {
  const target = journalPath(sessionId);
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return { lines: [], skipped: 0 };
  }
  const lines: JournalLine[] = [];
  let skipped = 0;
  for (const text of raw.split('\n')) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JournalLine;
      if (!parsed || typeof parsed.type !== 'string') {
        skipped++;
        continue;
      }
      lines.push(parsed);
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

export function computeJournalStats(sessionId: string): JournalStats {
  const { lines } = readJournal(sessionId);
  const stats: JournalStats = {
    lines: lines.length,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
    bytes: 0,
  };
  for (const line of lines) {
    switch (line.type) {
      case 'user': stats.userTurns++; break;
      case 'assistant': stats.assistantTurns++; break;
      case 'tool_call': stats.toolCalls++; break;
      case 'tool_result':
        if (line.data?.status === 'error') stats.toolErrors++;
        break;
      case 'compaction': stats.compactions++; break;
      case 'session_start': if (!stats.startedAt) stats.startedAt = line.ts; break;
      case 'session_end': stats.endedAt = line.ts; break;
      default: break;
    }
  }
  try {
    stats.bytes = fs.statSync(journalPath(sessionId)).size;
  } catch {
    // ignore
  }
  return stats;
}

/** Compact ledger of session ids with journals, newest first. */
export function listJournals(): { sessionId: string; bytes: number; mtimeMs: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(journalDirectory(), { withFileTypes: true });
  } catch {
    return [];
  }
  const result: { sessionId: string; bytes: number; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(journalDirectory(), entry.name);
    try {
      const info = fs.statSync(file);
      result.push({ sessionId: entry.name.replace(/\.jsonl$/, ''), bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // ignore
    }
  }
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Text replay of a journal, used by `bitacode sessions replay`. */
export function renderJournalReplay(sessionId: string, maxLines = 200): string[] {
  const { lines, skipped } = readJournal(sessionId);
  const out: string[] = [`session ${sessionId} — ${lines.length} lines`];
  if (skipped > 0) out.push(`(${skipped} unreadable line(s) skipped)`);
  out.push('');
  for (const line of lines.slice(-maxLines)) {
    const stamp = line.ts.slice(11, 19);
    const data = line.data ? ` ${JSON.stringify(line.data).slice(0, 160)}` : '';
    const content = line.content ? ` ${line.content.replace(/\s+/g, ' ').slice(0, 160)}` : '';
    out.push(`${stamp} ${line.type.padEnd(13)}${content}${data}`);
  }
  return out;
}

/** Delete a journal (used when a session is deleted). */
export function deleteJournal(sessionId: string): boolean {
  try {
    fs.rmSync(journalPath(sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

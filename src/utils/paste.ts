/**
 * paste.ts — Chinese-wall for large pastes.
 *
 * Pasting a 300-line log into the composer repaints hundreds of wrapped rows and
 * then sends the whole thing as one line. Instead, anything over a modest size is
 * written to a spill file and the composer gets a one-line marker naming it; the
 * model can then read the path like any other file, paging through it.
 *
 * Small pastes are left alone: summarising "two lines" is pure friction.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PASTE_LINE_THRESHOLD = 8;
export const PASTE_CHAR_THRESHOLD = 2_000;

export interface PasteSummary {
  /** Text to place in the composer. */
  text: string;
  /** True when the body was written to disk. */
  stored: boolean;
  /** Absolute path of the spill file, when stored. */
  path?: string;
  lines: number;
  chars: number;
  /** Set when the paste was too large even to store. */
  truncated?: boolean;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) lines++;
  return lines;
}

export function shouldStorePaste(text: string): boolean {
  if (!text) return false;
  return countLines(text) >= PASTE_LINE_THRESHOLD || text.length >= PASTE_CHAR_THRESHOLD;
}

/** One-line marker that replaces the pasted body. */
export function pasteMarker(filePath: string, lines: number, chars: number): string {
  return `[pasted ${lines} lines, ${chars.toLocaleString()} characters → ${filePath}]`;
}

export interface StorePasteOptions {
  /** Directory to write into; defaults to the bitacode data dir. */
  directory?: string;
  /** Prefix for the file name, e.g. the session id. */
  label?: string;
  /** Keep at most this many characters on disk. */
  maxChars?: number;
}

function defaultPasteDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode', 'pastes');
}

/**
 * Decide what the composer should receive for a paste, writing the body to disk
 * when it is large. Never throws: if writing fails the paste is kept inline and
 * the caller can decide to truncate.
 */
export async function summarizePaste(text: string, options: StorePasteOptions = {}): Promise<PasteSummary> {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = countLines(normalized);
  const chars = normalized.length;

  if (!shouldStorePaste(normalized)) {
    return { text: normalized, stored: false, lines, chars };
  }

  const maxChars = options.maxChars ?? 4 * 1024 * 1024;
  const body = normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
  const truncated = body.length < normalized.length;
  const directory = options.directory ?? defaultPasteDir();
  const label = (options.label ?? 'paste').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  const file = path.join(directory, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o600 });
    const marker = pasteMarker(file, lines, chars);
    return {
      text: truncated ? `${marker}\n[paste truncated to ${maxChars.toLocaleString()} characters]` : marker,
      stored: true,
      path: file,
      lines,
      chars,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch {
    // Fall back to an inline paste, capped so the composer stays usable.
    const inline = normalized.slice(0, 20_000);
    return {
      text: inline,
      stored: false,
      lines,
      chars,
      truncated: true,
    };
  }
}

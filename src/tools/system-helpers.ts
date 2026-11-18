/**
 * Shared helpers for the individually-split system tools: safe error
 * formatting, output capping, PATH executable lookup and an approval wrapper.
 *
 * Handlers return strings (never throw) and keep output capped so a large
 * environment or a burst of watch events cannot flood the model context.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requestApproval } from '../utils/approval.js';
import type { ApprovalRequest } from '../utils/approval.js';

const MAX_OUTPUT_CHARS = 4000;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const marker = `\n… truncated (${text.length} chars total)…`;
  return `${text.slice(0, MAX_OUTPUT_CHARS - marker.length)}${marker}`;
}

export function validateExecutableName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'Error: name must be a non-empty string.';
  if (name.includes('/') || name.includes('\\')) return 'Error: name must be an executable name, not a path.';
  return null;
}

export async function findExecutable(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const dir of dirs) candidates.push(path.join(dir, name));

  // On Windows a bare name resolves via PATHEXT; keep that case working too.
  if (process.platform === 'win32' && !path.extname(name)) {
    const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const ext of extensions) {
      for (const dir of dirs) candidates.push(path.join(dir, `${name}${ext}`));
    }
  }

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if ((await fs.promises.stat(candidate)).isFile()) return path.resolve(candidate);
    } catch {
      // Not executable here — try the next PATH entry.
    }
  }
  return null;
}

/** Returns null when approved, otherwise the caller's cancellation message. */
export async function requestApprovalOrMessage(
  req: ApprovalRequest,
  cancelMessage: string,
): Promise<string | null> {
  return (await requestApproval(req)) ? null : cancelMessage;
}

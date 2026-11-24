/**
 * Prompt draft stash — a tiny, private on-disk store for unfinished prompts.
 *
 * Drafts live in `<dataDir>/bitacode/drafts.json` with a 0700 directory and a
 * 0600 file. Every mutation rewrites that file atomically (temp file + rename)
 * and is bounded: at most 50 drafts, 20k characters of text each, 1MB total.
 * A corrupt file is reported as an error and is never overwritten, so a broken
 * stash can be inspected (or removed manually) instead of being silently lost.
 *
 * All functions return a `DraftResult`; they never throw. Returned drafts are
 * copies, so a caller cannot mutate the store by editing a result.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from './logger.js';

export interface DraftStash {
  id: string;
  text: string;
  label: string;
  savedAt: number;
}

export type DraftResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const STORE_DIRECTORY = 'bitacode';
const STORE_FILE = 'drafts.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_DRAFTS = 50;
const MAX_TEXT_LENGTH = 20_000;
const MAX_LABEL_LENGTH = 80;
const MAX_FILE_BYTES = 1_000_000;

// C0 controls except tab (0x09) and newline (0x0A), plus DEL and the C1 range.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ALL_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

interface StashOptions {
  dataDir?: string;
}

function failure<T>(error: string): DraftResult<T> {
  return { ok: false, error };
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error) && (error as NodeJS.ErrnoException).code === code;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function logError(action: string, error: unknown, fallback: string): string {
  const message = describe(error, fallback);
  try {
    logger.error(`Draft stash: ${action} failed: ${message}`);
  } catch {
    // Logging is best-effort; it must never turn a returned error into a throw.
  }
  return message;
}

function harden(target: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    try {
      logger.warn(`Draft stash: could not tighten permissions on ${target}: ${err}`);
    } catch {
      // Best-effort hygiene only.
    }
  }
}

function resolveDataDir(options?: StashOptions): string {
  const supplied = options?.dataDir;
  if (typeof supplied === 'string' && supplied.trim().length > 0) return supplied;
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local')
    : path.join(home, '.local', 'share');
}

/** Absolute path of the JSON file that holds the stash. */
export function stashPath(options?: StashOptions): string {
  return path.join(resolveDataDir(options), STORE_DIRECTORY, STORE_FILE);
}

function isDraft(value: unknown): value is DraftStash {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Partial<DraftStash>;
  return (
    typeof draft.id === 'string' && draft.id.length > 0 &&
    typeof draft.text === 'string' && draft.text.length <= MAX_TEXT_LENGTH &&
    typeof draft.label === 'string' && draft.label.length <= MAX_LABEL_LENGTH &&
    typeof draft.savedAt === 'number' && Number.isFinite(draft.savedAt)
  );
}

/** Read and fully validate the stash. A missing file means "empty". */
function readDrafts(filePath: string): DraftResult<DraftStash[]> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { ok: true, value: [] };
    return { ok: false, error: logError('read', err, 'Unable to read the draft stash') };
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
    return failure('Corrupt draft stash: file exceeds the 1MB size limit (left untouched)');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure('Corrupt draft stash: invalid JSON (file left untouched)');
  }
  if (!Array.isArray(parsed)) {
    return failure('Corrupt draft stash: expected an array of drafts (file left untouched)');
  }

  const drafts: DraftStash[] = [];
  const ids = new Set<string>();
  for (const entry of parsed) {
    if (!isDraft(entry) || ids.has(entry.id)) {
      return failure('Corrupt draft stash: malformed draft entry (file left untouched)');
    }
    ids.add(entry.id);
    drafts.push({ ...entry });
  }
  return { ok: true, value: drafts };
}

function atomicWrite(filePath: string, drafts: DraftStash[]): DraftResult<true> {
  const payload = JSON.stringify(drafts);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return failure(`Draft stash would exceed the 1MB size limit (${bytes} bytes)`);
  }

  let tempPath: string | undefined;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    harden(dir, DIR_MODE);
    tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, payload, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE });
    fs.renameSync(tempPath, filePath);
    tempPath = undefined;
    harden(filePath, FILE_MODE);
    return { ok: true, value: true };
  } catch (err) {
    if (tempPath) fs.rmSync(tempPath, { force: true });
    return { ok: false, error: logError('write', err, 'Unable to write the draft stash') };
  }
}

function sanitizeText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_TEXT_LENGTH);
}

function sanitizeLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  return label
    .replace(ALL_CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function newDraftId(used: Set<string>): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 8; i++) id += alphabet.charAt(crypto.randomInt(alphabet.length));
    if (!used.has(id)) return id;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Drop the oldest drafts until both the count and byte caps are satisfied. */
function enforceCaps(drafts: DraftStash[]): DraftStash[] {
  const kept = [...drafts];
  while (
    kept.length > MAX_DRAFTS ||
    Buffer.byteLength(JSON.stringify(kept), 'utf8') > MAX_FILE_BYTES
  ) {
    if (kept.length <= 1) break;
    let oldest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].savedAt < kept[oldest].savedAt) oldest = i;
    }
    kept.splice(oldest, 1);
  }
  return kept;
}

/** Save a new draft. Text is cleaned, the label is capped, and the LIFO store is pruned. */
export function saveDraft(
  text: string,
  label?: string,
  options?: StashOptions
): DraftResult<DraftStash> {
  try {
    const cleanText = sanitizeText(text);
    if (cleanText === null) return failure('Draft text must be a non-empty string');

    const filePath = stashPath(options);
    const read = readDrafts(filePath);
    if (!read.ok) return read;

    const draft: DraftStash = {
      id: newDraftId(new Set(read.value.map((entry) => entry.id))),
      text: cleanText,
      label: sanitizeLabel(label),
      savedAt: Date.now(),
    };
    const next = enforceCaps([...read.value, draft]);
    const written = atomicWrite(filePath, next);
    if (!written.ok) return written;
    return { ok: true, value: { ...draft } };
  } catch (err) {
    return { ok: false, error: logError('save', err, 'Unable to save the draft') };
  }
}

/** List all drafts, newest (highest `savedAt`) first. */
export function listDrafts(options?: StashOptions): DraftResult<DraftStash[]> {
  try {
    const read = readDrafts(stashPath(options));
    if (!read.ok) return read;
    const sorted = read.value
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.savedAt - a.entry.savedAt || b.index - a.index)
      .map(({ entry }) => ({ ...entry }));
    return { ok: true, value: sorted };
  } catch (err) {
    return { ok: false, error: logError('list', err, 'Unable to list drafts') };
  }
}

/**
 * Remove and return one draft. Pass its id, or `'latest'` for the most recently
 * saved one (highest `savedAt`, with later entries winning a tie).
 */
export function popDraft(id: string, options?: StashOptions): DraftResult<DraftStash> {
  try {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return failure('A draft id is required');
    }
    const filePath = stashPath(options);
    const read = readDrafts(filePath);
    if (!read.ok) return read;

    let index = read.value.findIndex((entry) => entry.id === id);
    if (id === 'latest') {
      let newest = -1;
      for (let i = 0; i < read.value.length; i++) {
        if (newest === -1 || read.value[i].savedAt >= read.value[newest].savedAt) newest = i;
      }
      index = newest;
    }
    if (index === -1) return failure(`Draft not found: ${id}`);

    const draft = { ...read.value[index] };
    const written = atomicWrite(filePath, read.value.filter((_, i) => i !== index));
    if (!written.ok) return written;
    return { ok: true, value: draft };
  } catch (err) {
    return { ok: false, error: logError('pop', err, 'Unable to pop the draft') };
  }
}

/** Delete a draft by id. `value` is false when the id does not exist. */
export function deleteDraft(id: string, options?: StashOptions): DraftResult<boolean> {
  try {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return failure('A draft id is required');
    }
    const filePath = stashPath(options);
    const read = readDrafts(filePath);
    if (!read.ok) return read;

    const remaining = read.value.filter((entry) => entry.id !== id);
    if (remaining.length === read.value.length) return { ok: true, value: false };
    const written = atomicWrite(filePath, remaining);
    if (!written.ok) return written;
    return { ok: true, value: true };
  } catch (err) {
    return { ok: false, error: logError('delete', err, 'Unable to delete the draft') };
  }
}

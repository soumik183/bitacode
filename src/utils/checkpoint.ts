/**
 * File checkpoints for /undo.
 *
 * Before a mutating tool runs, the executor snapshots the target file(s) as
 * JSON under ~/.local/share/bitacode/checkpoints/<sessionId>/. Each checkpoint
 * holds one path so restoring is unambiguous; a missing file is stored with
 * `content: null` so undo removes files that the tool created.
 *
 * All functions are best-effort and never throw.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface Checkpoint {
  path: string;
  content: string | null;
  createdAt: string;
  tool: string;
}

export interface StoredCheckpoint extends Checkpoint {
  id: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINTS_PER_SESSION = 100;
const DEFAULT_SESSION = 'default';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Resolve lazily so a changed HOME (tests) is respected on every call. */
function sessionDir(sessionId?: string): string {
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'bitacode', 'checkpoints')
    : path.join(home, '.local', 'share', 'bitacode', 'checkpoints');
  const safe = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120)
    : '';
  return path.join(base, safe || DEFAULT_SESSION);
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const cp = value as Partial<Checkpoint>;
  return validString(cp.path)
    && (cp.content === null || typeof cp.content === 'string')
    && typeof cp.createdAt === 'string'
    && typeof cp.tool === 'string';
}

function idFromFileName(fileName: string): string {
  const stem = fileName.slice(0, -'.json'.length);
  const dash = stem.indexOf('-');
  return dash === -1 ? stem : stem.slice(dash + 1);
}

/** Keep the newest MAX_CHECKPOINTS_PER_SESSION files, deleting older ones. */
async function prune(dir: string): Promise<void> {
  const files = (await fs.readdir(dir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - MAX_CHECKPOINTS_PER_SESSION))) {
    await fs.rm(path.join(dir, old), { force: true }).catch(() => undefined);
  }
}

/** Snapshot each path; returns the ids of checkpoints actually written. */
export async function createCheckpoint(
  paths: string[],
  sessionId?: string,
  tool?: string,
): Promise<string[]> {
  const ids: string[] = [];
  if (!Array.isArray(paths)) return ids;

  const dir = sessionDir(sessionId);
  const toolName = typeof tool === 'string' && tool.trim() ? tool : 'unknown';

  try {
    await fs.mkdir(dir, { recursive: true });
    for (const requested of paths) {
      if (!validString(requested)) continue;
      try {
        const absolute = path.resolve(process.cwd(), requested);
        let content: string | null = null;
        try {
          const stat = await fs.stat(absolute);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue; // skip dirs and oversized files
          content = await fs.readFile(absolute, 'utf8');
        } catch (err: any) {
          if (err?.code !== 'ENOENT') continue;
          // File does not exist yet — checkpoint it as null so undo deletes it.
        }

        const id = randomUUID().replaceAll('-', '').slice(0, 12);
        const createdAt = new Date().toISOString();
        const fileName = `${String(Date.now()).padStart(13, '0')}-${id}.json`;
        const checkpoint: Checkpoint = {
          path: requested,
          content,
          createdAt,
          tool: toolName,
        };
        await fs.writeFile(path.join(dir, fileName), JSON.stringify(checkpoint), 'utf8');
        ids.push(id);
      } catch {
        // One bad path must not lose the others.
      }
    }
    await prune(dir);
  } catch {
    // Best-effort: checkpointing never blocks the tool call.
  }
  return ids;
}

/** List checkpoints oldest-first so the last entry is the most recent. */
export async function listCheckpoints(sessionId?: string): Promise<StoredCheckpoint[]> {
  const result: StoredCheckpoint[] = [];
  try {
    const dir = sessionDir(sessionId);
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
    for (const fileName of files) {
      try {
        const raw = await fs.readFile(path.join(dir, fileName), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isCheckpoint(parsed)) continue;
        result.push({ ...parsed, id: idFromFileName(fileName) });
      } catch {
        // Skip corrupt or unreadable checkpoints.
      }
    }
  } catch {
    // No session directory yet.
  }
  return result;
}

/** Restore a checkpoint by id, then remove the checkpoint. Returns restored paths. */
export async function restoreCheckpoint(id: string, sessionId?: string): Promise<string[]> {
  const restored: string[] = [];
  if (!validString(id) || !ID_PATTERN.test(id)) return restored;

  try {
    const dir = sessionDir(sessionId);
    const files = (await fs.readdir(dir))
      .filter((name) => name.endsWith(`-${id}.json`))
      .sort();
    for (const fileName of files) {
      try {
        const file = path.join(dir, fileName);
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!isCheckpoint(parsed)) continue;

        const absolute = path.resolve(process.cwd(), parsed.path);
        if (parsed.content === null) {
          await fs.rm(absolute, { force: true });
        } else {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, parsed.content, 'utf8');
        }
        restored.push(parsed.path);
        await fs.rm(file, { force: true });
      } catch {
        // Keep the checkpoint if the restore failed so the user can retry.
      }
    }
  } catch {
    // Best-effort.
  }
  return restored;
}

/** Remove every checkpoint for a session (safe to call repeatedly). */
export async function clearCheckpoints(sessionId?: string): Promise<void> {
  try {
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

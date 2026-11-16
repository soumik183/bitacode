/**
 * File read-time tracking — staleness guard for edit_file.
 *
 * Rejects an edit when a file changed on disk after this process read it.
 * A resumed session has no in-memory read history, so edits there rely on
 * old_string matching the current content instead.
 */

import fs from 'node:fs';

const readTimes = new Map<string, number>(); // key: "sessionId:absolutePath" → epoch ms

/**
 * Record that a file was read at the current time.
 */
export function recordRead(sessionId: string, absolutePath: string): void {
  readTimes.set(`${sessionId}:${absolutePath}`, Date.now());
}

/**
 * Check that a file hasn't changed on disk since this process last read it.
 * Returns an error string if the check fails, or null if all is well.
 * Files with no read record are allowed: the read may have happened in the
 * previous process that owned this session.
 */
export function checkReadBefore(sessionId: string, absolutePath: string): string | null {
  const key = `${sessionId}:${absolutePath}`;
  const lastRead = readTimes.get(key);

  if (!lastRead) {
    // Resumed sessions start with an empty in-memory map. The edit still has
    // to match the file's current content, so only reject edits we know are
    // stale from an earlier read in this process.
    return null;
  }

  try {
    const mtime = fs.statSync(absolutePath).mtimeMs;
    if (mtime > lastRead + 100) {
      // Clear stale entry so the error message stays accurate on retry
      readTimes.delete(key);
      return `'${absolutePath}' has changed on disk since you last read it. Re-read it before editing.`;
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      readTimes.delete(key);
      return `'${absolutePath}' no longer exists on disk.`;
    }
    // Ignore other stat errors — don't block edits on stat failures
  }

  return null;
}

/**
 * Clear all read-time entries for a session (e.g. on session end).
 */
export function clearSession(sessionId: string): void {
  for (const key of readTimes.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      readTimes.delete(key);
    }
  }
}

/**
 * Read the current git branch for the footer's `~/folder:branch` label.
 * Best-effort: a missing git binary, a non-repo or a slow command yields null
 * and never affects the UI.
 */
import { execFile } from 'node:child_process';

export async function readGitBranch(cwd: string, timeoutMs = 1200): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const branch = String(stdout ?? '').trim();
        resolve(branch && branch !== 'HEAD' ? branch : null);
      }
    );
  });
}

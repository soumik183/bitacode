/**
 * Open a URL in a browser, preferring Google Chrome on Android/Termux and
 * falling back to the system default. Never throws: returns a short status
 * message suitable for a toast, including the URL when nothing could launch.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export const REPO_URL = 'https://github.com/soumik183/bitacode';
export const BUG_REPORT_URL = `${REPO_URL}/issues/new`;

type Spawn = (command: string, args: readonly string[]) => ChildProcess;

const OPEN_TIMEOUT_MS = 4000;

function validHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAndroid(): boolean {
  return process.platform === 'android' || Boolean(process.env.TERMUX_VERSION) || Boolean(process.env.ANDROID_ROOT);
}

interface Candidate {
  command: string;
  args: readonly string[];
}

/** Ordered launch attempts: Chrome first on Android, then the default handler. */
export function browserCandidates(
  url: string,
  platform = process.platform,
  preference = (process.env.BITACODE_BROWSER ?? '').trim()
): Candidate[] {
  // An explicit browser command always wins, including a wrapper script.
  if (preference && preference.toLowerCase() !== 'default') {
    return [{ command: preference, args: [url] }];
  }
  // `default` skips the Chrome-first attempt and uses the system handler.
  const useDefaultOnly = preference.toLowerCase() === 'default';
  // Env hints only apply when the caller did not override the platform.
  const android = platform === 'android' ||
    (platform === process.platform && Boolean(process.env.TERMUX_VERSION));
  if (android) {
    if (useDefaultOnly) return [{ command: 'termux-open-url', args: [url] }];
    return [
      { command: 'am', args: ['start', '-a', 'android.intent.action.VIEW', '-d', url, '-p', 'com.android.chrome'] },
      { command: 'termux-open-url', args: [url] },
      { command: 'am', args: ['start', '-a', 'android.intent.action.VIEW', '-d', url] },
    ];
  }
  if (platform === 'darwin') return [{ command: 'open', args: [url] }];
  if (platform === 'win32') return [{ command: 'cmd', args: ['/c', 'start', '', url] }];
  return [
    { command: 'xdg-open', args: [url] },
    { command: 'sensible-browser', args: [url] },
  ];
}

function attempt(candidate: Candidate, spawnFn: Spawn): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(candidate.command, [...candidate.args]);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? 'ok' : null));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(null);
    }, OPEN_TIMEOUT_MS);
  });
}

/** Try every candidate in order; return a toast message with the URL on failure. */
export async function openInBrowser(rawUrl: string, spawnFn: Spawn = spawn): Promise<string> {
  const url = validHttpUrl(rawUrl);
  if (!url) return `Error: invalid URL: ${String(rawUrl)}`;
  const fallback = `Open manually: ${url}`;
  let candidates: Candidate[];
  try {
    candidates = browserCandidates(url);
  } catch (err) {
    return `Error: could not resolve browser: ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const candidate of candidates) {
    const result = await attempt(candidate, spawnFn);
    if (result === 'ok') return `Opened in browser: ${url}`;
  }
  return fallback;
}

/** True when this process is on Android/Termux (used for messaging only). */
export const isAndroidRuntime = isAndroid;

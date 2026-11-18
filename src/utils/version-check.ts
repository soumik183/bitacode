/**
 * Silent, best-effort npm update check.
 *
 * Runs at startup without ever throwing or writing to stdout/stderr (an Ink
 * UI owns the terminal). Results are cached on disk with a TTL so repeated
 * launches don't hit the network.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import stripAnsi from 'strip-ansi';

const REGISTRY_URL = 'https://registry.npmjs.org/bitacode/latest';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1500;
const INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;
const PACKAGE_NAME = 'bitacode';

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface CacheEntry {
  lastChecked: number;
  latest: string;
}

function cachePath(homeDir: string): string {
  return join(homeDir, '.config', PACKAGE_NAME, 'update-check.json');
}

function readCache(homeDir: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(homeDir), 'utf8')) as Partial<CacheEntry>;
    if (
      typeof parsed.lastChecked === 'number' &&
      Number.isFinite(parsed.lastChecked) &&
      typeof parsed.latest === 'string' &&
      parsed.latest.length > 0
    ) {
      return { lastChecked: parsed.lastChecked, latest: parsed.latest };
    }
  } catch {
    // Missing, corrupt, or unreadable cache — treat as a miss.
  }
  return null;
}

function writeCache(homeDir: string, latest: string): void {
  try {
    const file = cachePath(homeDir);
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ lastChecked: Date.now(), latest } satisfies CacheEntry)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Unwritable home/FS — caching is optional, never fatal.
  }
}

/**
 * Compare two version strings (-1 / 0 / 1). Numeric dot sections, ignores a
 * leading `v`, tolerates differing lengths and build metadata, and sorts a
 * prerelease (`-alpha`, `-stage`) below the corresponding release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (input: string) => {
    let s = String(input ?? '').trim();
    if (s.startsWith('v') || s.startsWith('V')) s = s.slice(1);
    const plus = s.indexOf('+');
    if (plus !== -1) s = s.slice(0, plus);
    const dash = s.indexOf('-');
    const core = dash === -1 ? s : s.slice(0, dash);
    const pre = dash === -1 ? '' : s.slice(dash + 1);
    const nums = core.split('.').map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
    return { nums, pre: pre ? pre.split('.') : [] };
  };

  const va = parse(a);
  const vb = parse(b);
  const coreLen = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < coreLen; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  const pa = va.pre;
  const pb = vb.pre;
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return 1; // a release outranks any prerelease
  if (pb.length === 0) return -1;

  const preLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < preLen; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const xd = Number(x);
      const yd = Number(y);
      if (xd !== yd) return xd < yd ? -1 : 1;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1; // numeric < alphanumeric
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Look up the newest published version. Returns `null` on any failure and
 * never throws or prints anything, so callers can invoke it fire-and-forget.
 */
export async function checkForUpdate(
  currentVersion: string,
  options: {
    ttlMs?: number;
    timeoutMs?: number;
    homeDir?: string;
    force?: boolean;
  } = {},
): Promise<UpdateInfo | null> {
  try {
    const homeDir = options.homeDir ?? homedir();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let latest: string | null = null;
    if (!options.force) {
      const cached = readCache(homeDir);
      if (cached && Date.now() - cached.lastChecked < ttlMs) {
        latest = cached.latest;
      }
    }

    if (latest === null) {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const data = (await response.json()) as { version?: unknown };
      if (typeof data?.version !== 'string' || data.version.trim() === '') return null;
      latest = data.version.trim();
      writeCache(homeDir, latest);
    }

    return {
      current: currentVersion,
      latest,
      updateAvailable: compareVersions(currentVersion, latest) < 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort removal of the cached update check. Never throws. */
export function clearUpdateCache(homeDir: string = homedir()): void {
  try {
    rmSync(cachePath(homeDir), { force: true });
  } catch {
    // Nothing to do — clearing the cache is best-effort.
  }
}

/** Run `npm install [-g] bitacode@<version|latest>` without ever throwing. */
export async function installUpdate(options: {
  global?: boolean;
  version?: string;
  cwd?: string;
} = {}): Promise<{ success: boolean; message: string }> {
  const target = options.version?.trim() || 'latest';
  const pkg = `${PACKAGE_NAME}@${target}`;
  const args = options.global === false ? ['install', pkg] : ['install', '-g', pkg];

  let output = '';
  let timedOut = false;
  // Holder object: TS can't track assignments made inside event callbacks.
  const state: { spawnError: Error | null } = { spawnError: null };
  const append = (chunk: Buffer | string) => {
    if (output.length >= MAX_OUTPUT) return;
    output = (output + String(chunk)).slice(0, MAX_OUTPUT);
  };

  try {
    const child = spawn('npm', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INSTALL_TIMEOUT_MS);

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const code = await new Promise<number | null>((resolve) => {
      let settled = false;
      const done = (value: number | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on('error', (err) => {
        state.spawnError = err;
        done(null);
      });
      child.on('close', done);
    });
    clearTimeout(timer);

    const clean = stripAnsi(output).trim();
    if (timedOut) {
      return { success: false, message: `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s${clean ? `: ${clean}` : ''}` };
    }
    if (state.spawnError) {
      return { success: false, message: `npm install failed: ${state.spawnError.message}` };
    }
    if (code === 0) {
      return { success: true, message: clean || 'Update installed successfully.' };
    }
    return {
      success: false,
      message: `npm install exited with code ${code ?? 'unknown'}${clean ? `: ${clean}` : ''}`,
    };
  } catch (err) {
    return { success: false, message: `npm install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

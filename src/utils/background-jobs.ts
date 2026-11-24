/**
 * Background shell jobs whose completion is surfaced as a synthetic
 * `<task-notification>` message on the next agent iteration.
 *
 * The module is deliberately self-contained: it owns an in-process registry of
 * jobs, appends output to a private log file with a hard byte cap, and keeps
 * only a small tail of output in memory for the notification. All failures
 * (validation, spawn, logging, stop) are returned or recorded on the job
 * instead of throwing into the TUI event loop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number;
  /** truncated tail of output for the notification */
  summary?: string;
}

export type JobResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StartBackgroundJobOptions {
  command: string;
  cwd?: string;
  logPath?: string;
  maxLogBytes?: number;
  summaryChars?: number;
  /** caller-supplied safety gate; if it returns false the job is refused */
  validate?: (command: string, cwd: string) => boolean | string;
}

const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_SUMMARY_CHARS = 1200;

interface InternalJob {
  job: BackgroundJob;
  child: ChildProcess;
  logFd: number | null;
  logBytes: number;
  maxLogBytes: number;
  summaryChars: number;
  /** raw bytes so a multi-byte character split across chunks survives */
  tail: Buffer;
  /** guards against 'error' + 'close' + stop finalising the same job twice */
  finalized: boolean;
  stopRequested: boolean;
  exit: { code: number | null; signal: string | null } | null;
}

const registry = new Map<string, InternalJob>();

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function snapshot(job: BackgroundJob): BackgroundJob {
  return { ...job };
}

function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cleanupAfterSpawnFailure(fd: number, logPath: string, existed: boolean): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
  if (!existed) {
    try {
      unlinkSync(logPath);
    } catch {
      // Never mask the original spawn error with a cleanup failure.
    }
  }
}

/** Short, filesystem-safe id derived from a UUID (no user-controlled text). */
function newJobId(): string {
  let id: string;
  do {
    id = `bg-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  } while (registry.has(id));
  return id;
}

/** `${XDG_DATA_HOME || ~/.local/share}/bitacode/background`, mode 0700. */
function getBackgroundLogDirectory(): string {
  const base =
    typeof process.env.XDG_DATA_HOME === 'string' && process.env.XDG_DATA_HOME.trim()
      ? resolve(process.env.XDG_DATA_HOME)
      : join(homedir(), '.local', 'share');
  return join(base, 'bitacode', 'background');
}

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // mkdir's mode may be masked by the umask; be explicit about the final dir.
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: strict permissions are preferred, but logging must not break startup.
  }
}

function appendSummary(state: InternalJob, text: string): void {
  const combined = `${state.job.summary ?? ''}${text}`;
  state.job.summary =
    combined.length > state.summaryChars ? combined.slice(-state.summaryChars) : combined;
}

/** Append one chunk to the capped log and refresh the in-memory tail. */
function consumeOutput(state: InternalJob, chunk: Buffer): void {
  if (state.finalized || !chunk?.length) return;

  const room = state.maxLogBytes - state.logBytes;
  if (room > 0 && state.logFd !== null) {
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    try {
      writeSync(state.logFd, slice);
      state.logBytes += slice.length;
    } catch {
      // A full disk or closed fd must not break the job itself.
      state.logFd = null;
    }
  }

  // Keep the last summaryChars characters. Four bytes per char covers every
  // UTF-8 code point, so decoding at the end never needs a StringDecoder.
  const tailCap = state.summaryChars * 4;
  state.tail = Buffer.concat([state.tail, chunk]);
  if (state.tail.length > tailCap) {
    state.tail = state.tail.subarray(state.tail.length - tailCap);
  }
  state.job.summary = state.tail.toString('utf8').slice(-state.summaryChars);
}

/** Single finalisation path shared by error, close, stop and poll. */
function finalize(state: InternalJob, status: JobStatus, exitCode?: number): void {
  if (state.finalized) return;
  state.finalized = true;
  state.job.status = status;
  if (exitCode !== undefined) state.job.exitCode = exitCode;
  state.job.endedAt = Date.now();

  if (state.logFd !== null) {
    try {
      closeSync(state.logFd);
    } catch {
      // Already closed by another handler.
    }
    state.logFd = null;
  }
  state.tail = Buffer.alloc(0);
}

/** Terminate the job and, on POSIX, its whole detached process group. */
function terminate(state: InternalJob): void {
  const pid = state.child.pid;
  if (typeof pid !== 'number' || pid <= 0) return;
  if (
    process.platform !== 'win32' &&
    !state.child.killed &&
    state.child.exitCode === null &&
    state.child.signalCode === null
  ) {
    try {
      process.kill(-pid, 'SIGTERM');
      return;
    } catch {
      // No process group (or already gone); fall back to the child handle.
    }
  }
  try {
    state.child.kill('SIGTERM');
  } catch {
    // Already exited — nothing to stop.
  }
}

function wireHandlers(state: InternalJob): void {
  const child = state.child;

  // 'error' can fire for a failed spawn (ENOENT, EACCES, ...). Without a
  // listener Node would throw an unhandled 'error' event and crash the TUI.
  child.on('error', (err: Error) => {
    if (state.finalized) return;
    appendSummary(state, `\n[spawn error: ${errorText(err)}]`);
    finalize(state, 'failed');
  });

  // 'exit' records the raw outcome; 'close' finalises once stdio has drained so
  // the summary contains the last output the job produced.
  child.on('exit', (code, signal) => {
    state.exit = { code, signal };
  });

  child.on('close', (code, signal) => {
    if (state.finalized) return;
    state.exit = { code, signal };
    if (state.stopRequested) {
      finalize(state, 'stopped');
      return;
    }
    if (signal) appendSummary(state, `\n[terminated by ${signal}]`);
    if (code === 0) finalize(state, 'done', 0);
    else finalize(state, 'failed', typeof code === 'number' ? code : undefined);
  });

  if (child.stdout) child.stdout.on('data', (chunk: Buffer) => consumeOutput(state, chunk));
  if (child.stderr) child.stderr.on('data', (chunk: Buffer) => consumeOutput(state, chunk));
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Start a long-running shell command. Returns `{ ok: false, error }` for any
 * input/validation/filesystem problem. Runtime spawn failures are reported by
 * `pollBackgroundJob()` as a failed job.
 */
export function startBackgroundJob(options: StartBackgroundJobOptions): JobResult<BackgroundJob> {
  try {
    if (!options || typeof options !== 'object') {
      return { ok: false, error: 'startBackgroundJob: options must be an object' };
    }
    if (typeof options.command !== 'string' || !options.command.trim()) {
      return { ok: false, error: 'Background job refused: command must be a non-empty string' };
    }
    const command = options.command.trim();

    let cwd: string;
    try {
      cwd = resolve(typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd());
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { ok: false, error: `Invalid cwd for background job: ${cwd} is not a directory` };
      }
    } catch (err) {
      return { ok: false, error: `Invalid cwd for background job: ${errorText(err)}` };
    }

    if (options.validate !== undefined) {
      if (typeof options.validate !== 'function') {
        return { ok: false, error: 'Background job refused: validate must be a function' };
      }
      try {
        const verdict = options.validate(command, cwd);
        if (verdict !== true) {
          const reason =
            typeof verdict === 'string' && verdict.trim() ? verdict.trim() : 'blocked by validate';
          return { ok: false, error: `Background job refused by validate: ${reason}` };
        }
      } catch (err) {
        return { ok: false, error: `Background job refused by validate: ${errorText(err)}` };
      }
    }

    const maxLogBytes = positiveInt(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
    const summaryChars = positiveInt(options.summaryChars, DEFAULT_SUMMARY_CHARS);
    const id = newJobId();
    const logPath = options.logPath
      ? resolve(options.logPath)
      : join(getBackgroundLogDirectory(), `${id}.log`);

    let logFd: number | null = null;
    let logExisted = false;
    try {
      ensurePrivateDir(dirname(logPath));
      logExisted = existsSync(logPath);
      logFd = openSync(logPath, 'a', 0o600);
      try {
        fchmodSync(logFd, 0o600);
      } catch {
        // Best effort on filesystems that do not support fchmod.
      }
    } catch (err) {
      return { ok: false, error: `Cannot open background job log: ${errorText(err)}` };
    }
    if (logFd === null) {
      return { ok: false, error: 'Cannot open background job log: unknown error' };
    }

    const job: BackgroundJob = {
      id,
      command,
      cwd,
      logPath,
      startedAt: Date.now(),
      status: 'running',
      summary: '',
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.unref();
    } catch (err) {
      cleanupAfterSpawnFailure(logFd, logPath, logExisted);
      return { ok: false, error: `Failed to spawn background job: ${errorText(err)}` };
    }

    const state: InternalJob = {
      job,
      child,
      logFd,
      logBytes: 0,
      maxLogBytes,
      summaryChars,
      tail: Buffer.alloc(0),
      finalized: false,
      stopRequested: false,
      exit: null,
    };
    registry.set(job.id, state);
    wireHandlers(state);

    return { ok: true, value: snapshot(job) };
  } catch (err) {
    return { ok: false, error: `Failed to start background job: ${errorText(err)}` };
  }
}

export function getBackgroundJob(id: string): BackgroundJob | undefined {
  const state = typeof id === 'string' ? registry.get(id) : undefined;
  return state ? snapshot(state.job) : undefined;
}

export function listBackgroundJobs(): BackgroundJob[] {
  return Array.from(registry.values(), (state) => snapshot(state.job));
}

export function pollBackgroundJob(id: string): JobResult<BackgroundJob> {
  const state = typeof id === 'string' ? registry.get(id) : undefined;
  if (!state) return { ok: false, error: `Unknown background job: ${String(id)}` };
  return { ok: true, value: snapshot(state.job) };
}

export function stopBackgroundJob(id: string): JobResult<BackgroundJob> {
  const state = typeof id === 'string' ? registry.get(id) : undefined;
  if (!state) return { ok: false, error: `Unknown background job: ${String(id)}` };

  // Idempotent: stopping an already terminal job is a successful no-op.
  if (isTerminal(state.job.status)) return { ok: true, value: snapshot(state.job) };

  state.stopRequested = true;
  try {
    terminate(state);
  } catch {
    // Even if signalling fails, give the caller a terminal job.
  }
  finalize(state, 'stopped');
  return { ok: true, value: snapshot(state.job) };
}

/** Stop every job. Safe to call repeatedly and from a process 'exit' hook. */
export function stopAllBackgroundJobs(): number {
  let stopped = 0;
  for (const state of Array.from(registry.values())) {
    if (!isTerminal(state.job.status)) {
      stopBackgroundJob(state.job.id);
      stopped += 1;
    }
  }
  return stopped;
}

function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Collapse control characters and whitespace so the block stays one line per field. */
function oneLine(value: string): string {
  return String(value ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact `<task-notification>` block for injection as a synthetic user message. */
export function formatTaskNotification(job: BackgroundJob): string {
  const source = job && typeof job === 'object' ? job : ({} as BackgroundJob);
  const id = escapeXml(oneLine(String(source.id ?? 'unknown')));
  const status = escapeXml(oneLine(String(source.status ?? 'unknown')));
  const exitCode = typeof source.exitCode === 'number' ? String(source.exitCode) : 'unknown';
  const command = escapeXml(oneLine(String(source.command ?? '')));
  const summary = escapeXml(oneLine(String(source.summary ?? '')));
  return [
    `<task-notification id="${id}" status="${status}" exit-code="${exitCode}">`,
    `<command>${command}</command>`,
    `<summary>${summary}</summary>`,
    '</task-notification>',
  ].join('\n');
}

// Background jobs must not outlive the process that reports their notifications.
process.on('exit', () => {
  stopAllBackgroundJobs();
});

/**
 * Configuration hot-reload watcher.
 *
 * Watches the project and user config locations with `fs.watch` and coalesces
 * rapid changes per label before notifying the caller. All filesystem access is
 * best-effort: a missing path, an unavailable API or a throwing callback never
 * takes down the TUI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger.js';

const DEFAULT_DEBOUNCE_MS = 250;
const MAX_EVENTS = 50;
const PROJECT_DIR = '.bitacode';

export interface WatchTarget {
  path: string;
  label: string;
}

export interface WatchEvent {
  label: string;
  path: string;
  changedAt: number;
}

export interface ConfigWatcher {
  readonly events: readonly WatchEvent[];
  start(): boolean;
  stop(): void;
  /** test hook: feed a change event through the same debounce/notify path */
  notify(label: string, path: string): void;
}

/**
 * Paths for the config files/directories Bitacode reloads.
 *
 * Existence is intentionally not checked here: callers may want to display
 * these locations before they exist, and `createConfigWatcher` skips missing
 * targets when it starts.
 */
export function defaultWatchTargets(options?: { cwd?: string; home?: string }): WatchTarget[] {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.home ?? homedir();
  const project = path.join(cwd, PROJECT_DIR);
  const user = path.join(home, '.config', 'bitacode');

  return [
    { label: 'config', path: path.join(project, 'bitacode.jsonc') },
    { label: 'permissions', path: path.join(project, 'permissions.json') },
    { label: 'hooks', path: path.join(project, 'hooks.json') },
    { label: 'themes', path: path.join(project, 'themes') },
    { label: 'agents', path: path.join(project, 'agents') },
    { label: 'skills', path: path.join(project, 'skills') },
    { label: 'global-config', path: path.join(user, 'bitacode.jsonc') },
  ];
}

/** Editor temp/autosave names are rename churn, not real config changes. */
function isTemporaryFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return name.endsWith('~') || name.toLowerCase().endsWith('.tmp');
}

/** `fs.watch` hands back a string, Buffer or null depending on platform. */
function filenameOf(filename: string | Buffer | null): string | null {
  if (typeof filename === 'string') return filename;
  if (filename != null && typeof filename.toString === 'function') return filename.toString();
  return null;
}

function normalizeDebounce(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_DEBOUNCE_MS;
}

/** Debug logging is diagnostic only — it must never escape a watcher callback. */
function safeDebug(message: string, context?: Record<string, unknown>): void {
  try {
    logger.debug(message, context);
  } catch {
    // Ignore logging failures.
  }
}

export function createConfigWatcher(
  targets: WatchTarget[],
  onChange: (event: WatchEvent) => void,
  options?: { debounceMs?: number }
): ConfigWatcher {
  const debounceMs = normalizeDebounce(options?.debounceMs);
  const items = Array.isArray(targets) ? targets : [];
  const events: WatchEvent[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const handles = new Set<fs.FSWatcher>();
  let running = false;
  let disposed = false;

  /** Shared debounce/notify path used by both fs events and the test hook. */
  function notify(label: string, filePath: string): void {
    if (disposed) return;
    if (isTemporaryFile(filePath)) return;

    const pending = timers.get(label);
    if (pending !== undefined) {
      clearTimeout(pending);
      timers.delete(label);
    }

    const timer = setTimeout(() => {
      timers.delete(label);
      if (disposed) return;

      const event: WatchEvent = { label, path: filePath, changedAt: Date.now() };
      events.push(event);
      if (events.length > MAX_EVENTS) events.shift();

      try {
        onChange(event);
      } catch (err) {
        // A consumer error must not escape a timer or fs callback.
        safeDebug('config watch onChange failed', { label, path: filePath, error: String(err) });
      }
    }, debounceMs);

    timers.set(label, timer);
  }

  /** Translate an fs event for a target into a debounced config change. */
  function onFsEvent(target: WatchTarget, isDirectory: boolean, filename: string | Buffer | null): void {
    if (disposed) return;
    const name = filenameOf(filename);
    if (!name || isTemporaryFile(name)) return;
    if (!isDirectory && path.basename(name) !== path.basename(target.path)) return;
    notify(target.label, target.path);
  }

  /** Watch one target; failures are logged and skipped so others still work. */
  function watchTarget(target: WatchTarget): void {
    let watchPath: string;
    let isDirectory = false;
    try {
      if (!target || typeof target.path !== 'string' || !fs.existsSync(target.path)) return;
      isDirectory = fs.statSync(target.path).isDirectory();
      watchPath = isDirectory ? target.path : path.dirname(target.path);
    } catch (err) {
      safeDebug('config watch stat failed', { label: target?.label, path: target?.path, error: String(err) });
      return;
    }

    try {
      const handle = fs.watch(watchPath, { persistent: false }, (_eventType, filename) => {
        try {
          onFsEvent(target, isDirectory, filename);
        } catch (err) {
          safeDebug('config watch callback failed', { label: target.label, error: String(err) });
        }
      });
      handles.add(handle);
      if (typeof handle.on === 'function') {
        handle.on('error', (err: unknown) => {
          safeDebug('config watch error', { label: target.label, path: watchPath, error: String(err) });
          try {
            handle.close();
          } catch {
            // Already closed.
          }
          handles.delete(handle);
        });
      }
    } catch (err) {
      safeDebug('config watch could not start', { label: target.label, path: watchPath, error: String(err) });
    }
  }

  return {
    events,

    start(): boolean {
      if (running) return true;
      if (typeof fs.watch !== 'function') {
        safeDebug('fs.watch unavailable; config hot-reload disabled');
        return false;
      }

      running = true;
      disposed = false;
      for (const target of items) {
        if (!running) break;
        try {
          watchTarget(target);
        } catch (err) {
          safeDebug('config watch target failed', { label: target?.label, error: String(err) });
        }
      }
      return true;
    },

    stop(): void {
      running = false;
      disposed = true;
      for (const timer of timers.values()) {
        try {
          clearTimeout(timer);
        } catch {
          // Ignore timers that were already cancelled.
        }
      }
      timers.clear();
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // Ignore already-closed handles.
        }
      }
      handles.clear();
    },

    notify,
  };
}

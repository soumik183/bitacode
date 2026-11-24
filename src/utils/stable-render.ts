/**
 * Stable terminal repaints for Ink's standard renderer.
 *
 * Ink's standard mode erases every row of the previous frame (`eraseLines`)
 * and then writes the new one. On slow terminals that reads as a full-screen
 * blink, especially while streaming. Its incremental mode avoids the blink but
 * leaves rows behind whenever the frame's line count changes (which hid the
 * composer after loading a chat).
 *
 * This wrapper keeps the correctness of full repaints while removing the
 * erase-all: each repaint starts at the home position and overwrites every row
 * with `eraseEndLine`, so no row is ever blanked before it is redrawn. Chunks
 * that are not Ink repaints (alt-screen, mouse reporting, OSC colors, logs)
 * are passed through untouched.
 */
import type { WriteStream } from 'node:tty';
import type { EventEmitter } from 'node:events';

const ERASE_LINE = '\x1b[2K';
const ERASE_UP = '\x1b[1A';
const ERASE_END = '\x1b[G';

/** Length of Ink's `eraseLines(n)` prefix, or -1 when the chunk is not a repaint. */
function erasePrefixLength(text: string): number {
  let index = 0;
  while (text.startsWith(ERASE_LINE + ERASE_UP, index)) {
    index += ERASE_LINE.length + ERASE_UP.length;
  }
  if (!text.startsWith(ERASE_LINE + ERASE_END, index)) return -1;
  return index + ERASE_LINE.length + ERASE_END.length;
}

const instrumented = new WeakSet<object>();

/**
 * Last positive, finite row count seen on each installed stdout. `stdout.rows`
 * briefly reads 0/NaN during zoom bursts; jumping to the 24-row fallback then
 * would paint past the live screen, so keep the last real value instead. Keyed
 * by stream so a second install starts with its own baseline.
 */
const DEFAULT_ROWS = 24;
const lastValidRowsByStream = new WeakMap<object, number>();

/**
 * ED2/ED3: a physical display clear only counts when it *starts* a chunk
 * (optionally after a cursor-home sequence). An ESC[2J echoed inside tool
 * output is just text and must not reset the painted-row bookkeeping.
 */
// eslint-disable-next-line no-control-regex -- matching the terminal ESC is the point here
const FULL_CLEAR = /^(?:\x1b\[(?:[01]?;[01]?)?[Hf])?\x1b\[[23]J/;

export function installStableRenderer(stdout: WriteStream): void {
  // Installing twice would wrap the wrapper, so every frame would be rewritten
  // twice (double newlines, drifting cursor). Guard per stream.
  if (instrumented.has(stdout)) return;
  instrumented.add(stdout);

  const originalWrite = stdout.write.bind(stdout);
  let paintedRows = 0;

  (stdout as WriteStream).write = function stableWrite(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const passthrough = () => {
      // A dialog/resize full clear blanks the physical screen, so the padding
      // count no longer describes what is on it.
      if (FULL_CLEAR.test(text)) paintedRows = 0;
      return (originalWrite as any)(chunk, encodingOrCallback, callback);
    };
    const prefixLength = erasePrefixLength(text);

    // Not an Ink frame repaint (e.g. a bare clear) — pass through unchanged.
    if (prefixLength < 0 || text.length === prefixLength) return passthrough();

    const body = text.slice(prefixLength);
    const lastBreak = body.lastIndexOf('\n');
    // A repaint always ends its frame with a newline; anything after it is
    // Ink's cursor suffix. Be conservative if that invariant does not hold.
    if (lastBreak < 0) return passthrough();

    const lines = body.slice(0, lastBreak).split('\n');
    const suffix = body.slice(lastBreak + 1);
    const rowsNow = stdout.rows;
    if (typeof rowsNow === 'number' && Number.isFinite(rowsNow) && rowsNow > 0) {
      lastValidRowsByStream.set(stdout, Math.floor(rowsNow));
    }
    const lastValidRows = lastValidRowsByStream.get(stdout) ?? DEFAULT_ROWS;
    // A zoom-out can leave `paintedRows` far larger than the new terminal.
    // Never write past the live screen height, or we scroll stale rows into
    // view and leave a blank/black screen. App already renders at rows - 1.
    const maxRows = Math.max(1, lastValidRows - 1);
    while (paintedRows > lines.length && lines.length < maxRows) lines.push('');
    if (lines.length > maxRows) lines.length = maxRows;
    paintedRows = lines.length;

    const bodyRows = lines.map((line) => `${line}\x1b[K`).join('\n');
    // App renders at rows - 1, so the terminal's last row is never written by
    // a repaint. ED0 from the end of the final written row clears that row's
    // tail AND the whole unmanaged last row; the newline then lands on the
    // blank last row without scrolling.
    const rewritten = `\x1b[H${bodyRows}${lines.length ? '\x1b[J' : ''}\n${suffix}`;
    return (originalWrite as any)(rewritten, encodingOrCallback, callback);
  } as WriteStream['write'];
}

/** Bytes that restore a sane terminal after the TUI entered the alt screen. */
export function terminalRestoreSequence(): string {
  return '\x1b[?1006l\x1b[?1000l\x1b]111\x07\x1b[?1049l\x1b[?25h';
}

type RestoreEmitter = Pick<EventEmitter, 'on' | 'off'>;

const RESTORE_EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * One disposer per (stdout, emitter) pair. A global single disposer made a
 * second install on another stream silently no-op; the nested WeakMaps keep
 * each install independent and garbage-collectable while staying idempotent
 * for the same pair.
 */
const activeTerminalRestore = new WeakMap<object, WeakMap<object, () => void>>();

/**
 * Restore the terminal on exit or a signal even when React never unmounts
 * (Termux killing the app, terminal closing, native SIGTERM). The bytes are
 * written at most once per stream and this installer is idempotent per pair.
 * Ink's own signalExit handler is left alone — it still handles the actual
 * process teardown.
 */
export function installTerminalRestore(
  stdout: WriteStream,
  emitter: RestoreEmitter = process
): () => void {
  const existing = activeTerminalRestore.get(stdout)?.get(emitter);
  if (existing) return existing;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(terminalRestoreSequence());
  };
  for (const event of RESTORE_EVENTS) emitter.on(event, restore);

  const dispose = () => {
    for (const event of RESTORE_EVENTS) emitter.off(event, restore);
    const byEmitter = activeTerminalRestore.get(stdout);
    if (byEmitter?.get(emitter) === dispose) {
      byEmitter.delete(emitter);
      if (byEmitter.size === 0) activeTerminalRestore.delete(stdout);
    }
  };
  let byEmitter = activeTerminalRestore.get(stdout);
  if (!byEmitter) {
    byEmitter = new WeakMap<object, () => void>();
    activeTerminalRestore.set(stdout, byEmitter);
  }
  byEmitter.set(emitter, dispose);
  return dispose;
}

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

export function installStableRenderer(stdout: WriteStream): void {
  const originalWrite = stdout.write.bind(stdout);
  let paintedRows = 0;

  (stdout as WriteStream).write = function stableWrite(
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const prefixLength = erasePrefixLength(text);

    // Not an Ink frame repaint (e.g. a bare clear) — pass through unchanged.
    if (prefixLength < 0 || text.length === prefixLength) {
      return (originalWrite as any)(chunk, encodingOrCallback, callback);
    }

    const body = text.slice(prefixLength);
    const lastBreak = body.lastIndexOf('\n');
    // A repaint always ends its frame with a newline; anything after it is
    // Ink's cursor suffix. Be conservative if that invariant does not hold.
    if (lastBreak < 0) return (originalWrite as any)(chunk, encodingOrCallback, callback);

    const lines = body.slice(0, lastBreak).split('\n');
    const suffix = body.slice(lastBreak + 1);
    // Clear rows that belonged to a taller previous frame so they cannot linger.
    while (paintedRows > lines.length) lines.push('');
    paintedRows = lines.length;

    const rewritten = `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\n')}\n${suffix}`;
    return (originalWrite as any)(rewritten, encodingOrCallback, callback);
  } as WriteStream['write'];
}

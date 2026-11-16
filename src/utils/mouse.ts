// SGR mouse reports: ESC [ < button ; x ; y M/m. Ink strips the leading ESC
// before handing input to useInput, so accept both forms.
/* eslint-disable no-control-regex -- matching ESC is the point here */
const MOUSE_REPORT = /(?:\x1b)?\[?<(\d+);\d+;\d+[Mm]/g;
const LEFT_PRESS = /(?:\x1b)?\[?<(\d+);\d+;\d+M/g;
/* eslint-enable no-control-regex */

/** Remove mouse reports that would otherwise be inserted into a text input. */
export function stripMouseReports(input: string): string {
  return input.replace(MOUSE_REPORT, '');
}

export function isMouseReport(input: string): boolean {
  return input.length > 0 && stripMouseReports(input).length === 0;
}

/**
 * Net wheel direction: negative is wheel-up, positive is wheel-down.
 * Each matched report counts as one tick.
 */
export function getWheelDelta(input: string): number {
  let delta = 0;
  for (const match of input.matchAll(MOUSE_REPORT)) {
    const button = Number(match[1]);
    if ((button & 64) !== 0) {
      delta += (button & 1) !== 0 ? 1 : -1;
    }
  }
  return delta;
}

export interface MousePress {
  x: number;
  y: number;
}

export function hasLeftMousePress(input: string): boolean {
  return getLeftMousePress(input) !== null;
}

/**
 * Thinking block sits directly above the input + footer (3 + 2 rows).
 * A click is only valid inside those rows.
 */
export function isClickOnThinkingBlock(y: number, rows: number, blockHeight: number): boolean {
  const bottomRow = rows - 5;
  return y <= bottomRow && y >= bottomRow - blockHeight + 1;
}

/** Coordinates of a left-button press, or null for wheel/drag/release events. */
export function getLeftMousePress(input: string): MousePress | null {
  for (const match of input.matchAll(LEFT_PRESS)) {
    const button = Number(match[1]);
    // Bit 64 is wheel, bit 32 is drag/motion, low bits 0 are the left button.
    if ((button & 64) === 0 && (button & 32) === 0 && (button & 3) === 0) {
      const parts = match[0].split(';');
      return { x: Number(parts[1]), y: Number(parts[2].replace(/[Mm]$/, '')) };
    }
  }
  return null;
}

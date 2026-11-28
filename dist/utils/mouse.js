import { fixedChromeRows, resolveLayout } from './layout.js';
// SGR mouse reports: ESC [ < button ; x ; y M/m. Ink strips the leading ESC
// before handing input to useInput, so accept both forms.
/* eslint-disable no-control-regex -- matching ESC is the point here */
const MOUSE_REPORT = /(?:\x1b)?\[?<(\d+);\d+;\d+[Mm]/g;
const LEFT_PRESS = /(?:\x1b)?\[?<(\d+);\d+;\d+M/g;
/* eslint-enable no-control-regex */
/** Remove mouse reports that would otherwise be inserted into a text input. */
export function stripMouseReports(input) {
    return input.replace(MOUSE_REPORT, '');
}
export function isMouseReport(input) {
    return input.length > 0 && stripMouseReports(input).length === 0;
}
/**
 * Net wheel direction: negative is wheel-up, positive is wheel-down.
 * Each matched report counts as one tick.
 */
export function getWheelDelta(input) {
    let delta = 0;
    for (const match of input.matchAll(MOUSE_REPORT)) {
        const button = Number(match[1]);
        if ((button & 64) === 0 || (button & 32) !== 0)
            continue; // wheel only, not drag
        // SGR wheel buttons: 64 up, 65 down, 66/67 horizontal left/right. Masking
        // with 0x7 keeps the direction without letting 66 look like vertical up.
        switch (button & 0x7) {
            case 0:
                delta -= 1;
                break; // wheel up
            case 1:
                delta += 1;
                break; // wheel down
            default: break; // horizontal wheel: handled explicitly as no vertical scroll
        }
    }
    return delta;
}
export function hasLeftMousePress(input) {
    return getLeftMousePress(input) !== null;
}
/**
 * Thinking block sits directly above the fixed chrome below the transcript.
 * Use the shared, dense-aware chrome budget instead of a hard-coded 5 rows so
 * short terminals (where padding is dropped) hit the right rows too.
 */
export function isClickOnThinkingBlock(y, rows, blockHeight) {
    const { dense } = resolveLayout(1, rows);
    const bottomRow = rows - fixedChromeRows({ dense });
    return y <= bottomRow && y >= bottomRow - blockHeight + 1;
}
/** Coordinates of a left-button press, or null for wheel/drag/release events. */
export function getLeftMousePress(input) {
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

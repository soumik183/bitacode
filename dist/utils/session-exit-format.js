/**
 * Post-exit session card. Printed straight to stdout after Ink unmounts, so
 * it lives outside the alternate screen and keeps its own colours. Kept pure
 * (no stdout access) so the exact bytes can be tested.
 */
/** This package's own bin, so the printed command always works. */
export const RESUME_PACKAGE = 'npx bitacode@latest';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
function rgb(hex) {
    const value = hex.replace('#', '');
    const n = Number.parseInt(value, 16);
    if (!Number.isFinite(n) || value.length !== 6)
        return '';
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
/** Letter-spaced display type — deliberately different from the chat wordmark. */
const BANNER = 'S E S S I O N   S A V E D';
export function formatSessionExit(sessionId, palette) {
    const id = sessionId.trim();
    if (!id)
        return '';
    const rule = '─'.repeat(Math.max(24, Math.min(72, BANNER.length + 6)));
    const accent = rgb(palette.accent);
    const border = rgb(palette.border);
    const text = rgb(palette.text);
    const dim = rgb(palette.dim);
    const command = `${RESUME_PACKAGE} --session ${id}`;
    return [
        '',
        `  ${accent}${BOLD}${BANNER}${RESET}`,
        `  ${border}${rule}${RESET}`,
        `  ${dim}Resume this conversation${RESET}`,
        '',
        `  ${text}${BOLD}${command}${RESET}`,
        '',
        `  ${border}${rule}${RESET}`,
        '',
    ].join('\n');
}

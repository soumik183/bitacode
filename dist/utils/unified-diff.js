import { createTwoFilesPatch } from 'diff';
/** Keep tool-result diffs small enough for the model and the terminal. */
export const MAX_TOOL_DIFF_LINES = 80;
/** Unified diff with the `Index:`/separator noise normalised away. */
export function computeUnifiedDiff(oldContent, newContent, filePath, context = 3) {
    const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, oldContent, newContent, undefined, undefined, { context });
    const lines = patch.split('\n');
    // createTwoFilesPatch prefixes an "=" separator line.
    if (lines[0]?.startsWith('='))
        lines.shift();
    if (lines.length > MAX_TOOL_DIFF_LINES) {
        return [...lines.slice(0, MAX_TOOL_DIFF_LINES), '... (diff truncated)'].join('\n');
    }
    return lines.join('\n').trimEnd();
}

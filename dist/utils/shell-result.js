/** Pure helpers that turn bash results into UI-friendly data. */
import stripAnsi from 'strip-ansi';
function parseArgs(args) {
    if (!args)
        return {};
    if (typeof args === 'object')
        return args;
    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * Turns a bash tool result into a card model. Returns null for other tools so
 * callers can fall back to the generic one-line tool result.
 */
export function parseShellResult(toolName, args, result) {
    if (toolName !== 'bash')
        return null;
    const command = parseArgs(args).command;
    if (typeof command !== 'string' || !command.trim())
        return null;
    const text = stripAnsi(result).trim();
    const exit = /^Command exited with code (-?\d+)\./.exec(text);
    const isError = Boolean(exit) ||
        /^(Error\b|File not found\b|Operation cancelled\b|Command (?:timed out|aborted|cancelled|blocked)\b)/i.test(text);
    let status;
    if (exit)
        status = `exit ${exit[1]}`;
    else if (/^Command timed out/i.test(text))
        status = 'timed out';
    else if (/^Command aborted/i.test(text))
        status = 'aborted';
    else if (/^Command cancelled/i.test(text))
        status = 'cancelled';
    else if (/^Command blocked/i.test(text))
        status = 'blocked';
    else if (isError)
        status = 'failed';
    return {
        command: command.trim(),
        // Keep the full result; the view decides what to preview.
        output: stripAnsi(result).replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        isError,
        status,
    };
}

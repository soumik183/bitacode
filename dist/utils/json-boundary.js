/**
 * json-boundary.ts — find the end of a complete JSON value in a stream.
 *
 * A tool call's arguments arrive as a growing string. The stream can only be
 * acted on early if we can tell when the argument object is *finished*, which
 * needs a scanner that understands strings, escapes and nesting — a brace count
 * is wrong for `{"code":"if (x) { ... }"}`.
 *
 * Pure and allocation-free apart from the returned index, so it can be called on
 * every delta.
 */
/** Index of the first `{` or `[`, or -1. */
export function firstJsonStart(text, from = 0) {
    for (let index = from; index < text.length; index++) {
        const char = text[index];
        if (char === '{' || char === '[')
            return index;
    }
    return -1;
}
/**
 * Index just past the value that starts at `from` (which must be `{` or `[`),
 * or null while the value is still incomplete.
 */
export function completeJsonBoundary(text, from = 0) {
    const start = from > 0 ? from : firstJsonStart(text);
    if (start < 0 || start >= text.length)
        return null;
    const opener = text[start];
    if (opener !== '{' && opener !== '[')
        return null;
    const stack = [opener === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === '\\') {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') {
            stack.push('}');
            continue;
        }
        if (char === '[') {
            stack.push(']');
            continue;
        }
        if (char === '}' || char === ']') {
            if (stack.length === 0 || stack[stack.length - 1] !== char)
                return null;
            stack.pop();
            if (stack.length === 0)
                return index + 1;
            continue;
        }
    }
    return null;
}
/** True when `text` starts with a JSON object/array that is complete and parses. */
export function isCompleteJson(text) {
    const end = completeJsonBoundary(text);
    if (end === null)
        return false;
    try {
        JSON.parse(text.slice(firstJsonStart(text), end));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Split a stream that may contain several concatenated JSON values, returning
 * only the ones that are finished. Used by providers that emit bare JSON lines.
 */
export function splitCompleteJsonValues(text) {
    const values = [];
    let rest = text;
    for (;;) {
        const start = firstJsonStart(rest);
        if (start < 0)
            break;
        const end = completeJsonBoundary(rest, start);
        if (end === null)
            break;
        values.push(rest.slice(start, end));
        rest = rest.slice(end);
    }
    return { values, rest };
}
/** True while a string literal is still open (useful for "args look complete"). */
export function hasUnterminatedString(text) {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
        }
        else if (char === '"') {
            inString = true;
        }
    }
    return inString;
}

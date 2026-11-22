/**
 * Split text into plain and file-path spans so path names can be coloured in
 * the composer and in sent messages. Pure and dependency-free: callers decide
 * which palette colour to paint the `path` spans with.
 */
// `src/App.tsx`, `./package.json`, `/etc/hosts`, `file.ts`. URLs are excluded
// by requiring the token not to be preceded by `://` or `www.`.
const PATH_RE = /(\b(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[A-Za-z0-9]{1,8}\b)/g;
const URL_PREFIX = /(?:https?:\/\/|www\.)/i;
/** Split `text` into consecutive spans, merging adjacent same-kind runs. */
export function splitPathTokens(text) {
    if (!text)
        return [];
    const spans = [];
    let cursor = 0;
    PATH_RE.lastIndex = 0;
    for (const match of text.matchAll(PATH_RE)) {
        const start = match.index ?? 0;
        const value = match[0];
        // Skip matches that are part of a URL or an email-like token.
        const before = text.slice(Math.max(0, start - 8), start);
        if (URL_PREFIX.test(before) || (start > 0 && /[\w@]$/.test(text[start - 1] ?? '')))
            continue;
        if (start > cursor)
            spans.push({ text: text.slice(cursor, start), path: false });
        spans.push({ text: value, path: true });
        cursor = start + value.length;
    }
    if (cursor < text.length)
        spans.push({ text: text.slice(cursor), path: false });
    return spans.length > 0 ? spans : [{ text, path: false }];
}

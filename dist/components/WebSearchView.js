import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { displayWidth } from '../utils/format-message.js';
import { LeftBar } from './LeftBar.js';
import { parseWebSearchResult, } from '../utils/web-search-result.js';
// The bar, its margin and the card padding take 4 columns; reserve a little
// more slack so a zoomed-in frame never wraps a URL onto the next row.
function contentWidth(columns) {
    return Math.max(1, (columns ?? 80) - 8);
}
/** Cut to a display-column budget so wide CJK/emoji cannot wrap the card. */
function clipToWidth(text, width) {
    const limit = Math.max(1, Math.floor(width));
    if (displayWidth(text) <= limit)
        return text;
    let used = 0;
    let out = '';
    for (const ch of text) {
        const w = displayWidth(ch);
        if (used + w > limit)
            break;
        used += w;
        out += ch;
    }
    return out;
}
function shorten(url, width) {
    if (displayWidth(url) <= width)
        return url;
    const keep = Math.max(1, width - 1);
    return `${clipToWidth(url, keep)}…`;
}
/** Snippets follow the frame width instead of a fixed 170-character cut. */
function snippet(text, width) {
    const one = text.replace(/\s+/g, ' ').trim();
    const budget = Math.max(1, Math.floor(width) - 3); // indent for the snippet
    if (displayWidth(one) <= budget)
        return one;
    return `${clipToWidth(one, Math.max(1, budget - 1))}…`;
}
const ResourceRow = ({ resource, width, color }) => {
    const theme = useTheme();
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: color, wrap: "truncate-end", children: `↗ ${shorten(resource.url, width)}` }), resource.text ? (_jsx(Text, { color: theme.muted, wrap: "truncate-end", children: `   ${snippet(resource.text, width)}` })) : null] }));
};
export const WebSearchView = ({ payload, maxResources = 24, columns }) => {
    const theme = useTheme();
    const width = contentWidth(columns);
    const resources = payload.blocks.flatMap((block) => block.resources).slice(0, maxResources);
    const queryLabel = payload.queries.length === 1 ? payload.queries[0] : `${payload.queries.length} queries`;
    return (_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsx(LeftBar, { color: theme.info, children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, wrap: "truncate-end", children: [_jsx(Text, { color: theme.accent, children: '⌕ Web search' }), _jsx(Text, { color: theme.dim, children: `  ${queryLabel}` }), _jsx(Text, { color: theme.dim, children: ` · ${resources.length} resource${resources.length === 1 ? '' : 's'}` })] }), resources.map((resource, index) => (_jsx(ResourceRow, { resource: resource, width: width, color: theme.info }, `${resource.url}-${index}`))), payload.blocks.some((block) => block.error) ? (_jsx(Box, { flexDirection: "column", children: payload.blocks
                            .filter((block) => block.error)
                            .map((block, index) => (_jsx(Text, { color: theme.error, wrap: "truncate-end", children: `✗ ${block.query}: ${block.error}` }, `err-${index}`))) })) : null, payload.related.length > 0 ? (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.dim, children: 'Related: ' }), payload.related.map((item, index) => (_jsxs(Text, { children: [index > 0 ? _jsx(Text, { color: theme.dim, children: ' · ' }) : null, _jsx(Text, { color: theme.info, children: item })] }, `rel-${index}`)))] })) : null] }) }) }));
};
/** A short, tidy card for cases where the search never produced a payload. */
export const WebSearchErrorView = ({ message, columns }) => {
    const theme = useTheme();
    const width = contentWidth(columns);
    const text = message.replace(/^Error:\s*/i, '');
    return (_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsx(LeftBar, { color: theme.error, children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: theme.error, bold: true, wrap: "truncate-end", children: '✗ Web search' }), _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: clipToWidth(text, width) })] }) }) }));
};
/** Convenience for callers that only have the raw tool result string. */
export const WebSearchResultView = ({ raw, columns }) => {
    const payload = parseWebSearchResult(raw);
    return payload
        ? _jsx(WebSearchView, { payload: payload, columns: columns })
        : _jsx(WebSearchErrorView, { message: raw, columns: columns });
};
export default WebSearchView;

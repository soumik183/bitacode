import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { LeftBar } from './LeftBar.js';
import { parseWebSearchResult, } from '../utils/web-search-result.js';
const MAX_RESOURCE_CHARS = 170;
// The bar, its margin and the card padding take 4 columns; reserve a little
// more slack so a zoomed-in frame never wraps a URL onto the next row.
function contentWidth(columns) {
    return Math.max(1, (columns ?? 80) - 8);
}
function shorten(url, width) {
    if (url.length <= width)
        return url;
    const keep = Math.max(12, width - 1);
    return `${url.slice(0, keep)}…`;
}
function snippet(text) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length <= MAX_RESOURCE_CHARS ? one : `${one.slice(0, MAX_RESOURCE_CHARS - 1)}…`;
}
const ResourceRow = ({ resource, width, color }) => (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: color, wrap: "truncate-end", children: `↗ ${shorten(resource.url, width)}` }), resource.text ? (_jsx(Text, { color: "muted", wrap: "wrap", children: `   ${snippet(resource.text)}` })) : null] }));
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
export const WebSearchErrorView = ({ message }) => {
    const theme = useTheme();
    return (_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsx(LeftBar, { color: theme.error, children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: theme.error, bold: true, wrap: "truncate-end", children: '✗ Web search' }), _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: message.replace(/^Error:\s*/i, '') })] }) }) }));
};
/** Convenience for callers that only have the raw tool result string. */
export const WebSearchResultView = ({ raw, columns }) => {
    const payload = parseWebSearchResult(raw);
    return payload
        ? _jsx(WebSearchView, { payload: payload, columns: columns })
        : _jsx(WebSearchErrorView, { message: raw, columns: columns });
};
export default WebSearchView;

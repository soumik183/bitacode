import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
/** One-line transcript summary for a file read: no box, no code. */
export const ReadSummaryView = ({ summary, error }) => {
    const theme = useTheme();
    const path = summary?.filePath || 'file';
    const meta = error
        ? error
        : summary?.empty
            ? 'empty'
            : typeof summary?.total === 'number'
                ? `${summary.total} lines`
                : summary?.range
                    ? summary.range
                    : 'empty';
    const highlight = !error && !summary?.empty && (Boolean(summary?.range) || typeof summary?.total === 'number');
    return (_jsx(Box, { paddingX: 2, marginBottom: 1, overflow: "hidden", children: _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: '▤ ' }), _jsx(Text, { color: theme.text, children: path }), _jsx(Text, { color: theme.dim, children: ' · ' }), _jsx(Text, { color: error ? theme.error : highlight ? theme.accent : theme.dim, children: meta })] }) }));
};
export default ReadSummaryView;

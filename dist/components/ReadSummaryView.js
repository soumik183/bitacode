import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
/** One-line transcript summary for a read_file result: no box, no code. */
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
                    ? `lines ${summary.range}`
                    : 'empty';
    return (_jsx(Box, { paddingX: 2, marginY: 1, overflow: "hidden", children: _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: '▤ ' }), _jsx(Text, { color: theme.text, children: path }), _jsx(Text, { color: error ? theme.error : theme.dim, children: ` · ${meta}` })] }) }));
};
export default ReadSummaryView;

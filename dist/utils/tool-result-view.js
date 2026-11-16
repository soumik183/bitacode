import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { DiffView } from '../components/DiffView.js';
import { ReadFileView } from '../components/ReadFileView.js';
import { ShellView } from '../components/ShellView.js';
import { theme } from '../theme.js';
import { parseFileMutationDiff, parseFileReadResult } from './file-diff.js';
import { parseShellResult } from './shell-result.js';
import { formatToolActivity } from './tool-display.js';
function parseArgs(args) {
    if (!args)
        return null;
    if (typeof args === 'object')
        return args;
    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * Render one tool result into the transcript. File mutations and reads keep
 * their existing cards; bash gets an expandable shell card; everything else
 * keeps the compact one-line activity row.
 */
export function addToolResultView(addStatic, toolName, toolArgs, rawResult) {
    const fileDiff = parseFileMutationDiff(toolName, toolArgs, rawResult);
    if (fileDiff) {
        addStatic(_jsx(DiffView, { header: fileDiff.header, diff: fileDiff.diff, filePath: fileDiff.filePath, operation: fileDiff.operation }));
        return;
    }
    const fileRead = parseFileReadResult(toolName, toolArgs, rawResult);
    if (fileRead) {
        addStatic(_jsx(ReadFileView, { ...fileRead }));
        return;
    }
    const shell = parseShellResult(toolName, toolArgs, rawResult);
    if (shell) {
        const collapsed = _jsx(ShellView, { ...shell, expanded: false });
        const expanded = _jsx(ShellView, { ...shell, expanded: true });
        addStatic(collapsed, { collapsed, expanded });
        return;
    }
    const parsedArgs = parseArgs(toolArgs);
    const toolDisplay = parsedArgs ? formatToolActivity(toolName, parsedArgs) : toolName;
    const compactResult = rawResult.replace(/\s+/g, ' ').trim().slice(0, 180);
    const isError = /^(Error\b|File not found\b|Operation cancelled\b)/i.test(rawResult.trim());
    addStatic(_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsxs(Text, { color: isError ? theme.error : undefined, dimColor: !isError, children: ['▶ ', toolDisplay, ': ', compactResult] }) }));
}

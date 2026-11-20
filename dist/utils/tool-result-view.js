import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { CodeBlock } from '../components/CodeBlock.js';
import { DiffView, DIFF_PREVIEW_LINES } from '../components/DiffView.js';
import { ReadFileView, READ_PREVIEW_LINES } from '../components/ReadFileView.js';
import { ShellView } from '../components/ShellView.js';
import { getTheme } from '../theme.js';
import { detectLanguage } from './code-highlight.js';
import { annotateDiff, displayFilePath, parseFileMutationDiff, parseFileReadResult } from './file-diff.js';
import { parseShellResult } from './shell-result.js';
import { formatToolActivity } from './tool-display.js';
import { isNotification } from '../tools/notify.js';
import { parseProgress } from '../tools/progress.js';
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
/** Best-effort file hint from the tool arguments. */
function codeHint(args) {
    const parsed = parseArgs(args);
    if (!parsed)
        return undefined;
    for (const key of ['file_path', 'path', 'filename', 'file']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
/** Only multi-line, clearly code-like results get a full code box. */
function looksLikeCode(text) {
    const trimmed = text.trim();
    if (trimmed.length < 2 || trimmed.length > 4000)
        return false;
    if (trimmed.split('\n').length < 3)
        return false;
    return /(?:=|\{|\}|=>|\bfunction\b|\bdef\b|\bimport\b|\bexport\b|\/\/|^\s*#{1,6}\s)/m.test(trimmed);
}
function toolCodeLanguage(args, result) {
    const hint = codeHint(args);
    if (hint)
        return { language: detectLanguage(hint), hint };
    return { language: /^\s*[{[]/.test(result.trim()) ? 'json' : 'text' };
}
/**
 * Render one tool result into the transcript. File mutations and reads keep
 * their existing cards; bash gets an expandable shell card; code-ish results
 * get a bounded highlighted box; everything else keeps the compact one-line
 * activity row.
 */
export function addToolResultView(addStatic, toolName, toolArgs, rawResult, palette = getTheme()) {
    // Notifications and progress reports get dedicated, colorful cards instead
    // of being flattened into a generic one-line activity row.
    if (isNotification(rawResult)) {
        const message = rawResult.replace(/^NOTIFY:\s*/i, '');
        addStatic(_jsxs(Box, { paddingX: 2, marginBottom: 1, children: [_jsx(Text, { color: palette.info, bold: true, children: "\uD83D\uDD14 " }), _jsx(Text, { color: palette.text, children: message })] }));
        return;
    }
    const progressInfo = parseProgress(rawResult);
    if (progressInfo) {
        const filled = Math.round((progressInfo.percent / 100) * 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        addStatic(_jsxs(Box, { paddingX: 2, marginBottom: 1, children: [_jsx(Text, { color: palette.accent, bold: true, children: `⏵ ${bar} ${progressInfo.percent}%` }), progressInfo.label ? _jsxs(Text, { color: palette.muted, children: [" ", progressInfo.label] }) : null] }));
        return;
    }
    const fileDiff = parseFileMutationDiff(toolName, toolArgs, rawResult);
    if (fileDiff) {
        const collapsed = _jsx(DiffView, { ...fileDiff });
        // Only offer expansion when there is actually more to see, so a short
        // patch does not advertise a toggle that would do nothing.
        const truncated = annotateDiff(fileDiff.diff).length > DIFF_PREVIEW_LINES;
        const expanded = _jsx(DiffView, { ...fileDiff, expanded: true });
        addStatic(collapsed, truncated ? { collapsed, expanded } : undefined);
        return;
    }
    const fileRead = parseFileReadResult(toolName, toolArgs, rawResult);
    if (fileRead) {
        const totalLines = fileRead.sections.reduce((total, section) => total + section.lines.length, 0);
        const collapsed = _jsx(ReadFileView, { ...fileRead });
        const expanded = _jsx(ReadFileView, { ...fileRead, expanded: true });
        addStatic(collapsed, totalLines > READ_PREVIEW_LINES ? { collapsed, expanded } : undefined);
        return;
    }
    const shell = parseShellResult(toolName, toolArgs, rawResult);
    if (shell) {
        const collapsed = _jsx(ShellView, { ...shell, expanded: false });
        const expanded = _jsx(ShellView, { ...shell, expanded: true });
        addStatic(collapsed, { collapsed, expanded });
        return;
    }
    const code = toolCodeLanguage(toolArgs, rawResult);
    if (code.language !== 'text' && looksLikeCode(rawResult)) {
        addStatic(_jsx(CodeBlock, { code: rawResult, language: code.language, filename: code.hint ? displayFilePath(code.hint) : undefined, showHeader: true, showLineNumbers: true, maxRows: 8 }));
        return;
    }
    const parsedArgs = parseArgs(toolArgs);
    const toolDisplay = parsedArgs ? formatToolActivity(toolName, parsedArgs) : toolName;
    const compactResult = rawResult.replace(/\s+/g, ' ').trim().slice(0, 180);
    const isError = /^(Error\b|File not found\b|Operation cancelled\b)/i.test(rawResult.trim());
    addStatic(_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsxs(Text, { color: isError ? palette.error : undefined, dimColor: !isError, children: ['▶ ', toolDisplay, ': ', compactResult] }) }));
}

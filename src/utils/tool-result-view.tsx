import React from 'react';
import { Box, Text } from 'ink';
import { CodeBlock } from '../components/CodeBlock.js';
import { DiffView } from '../components/DiffView.js';
import { ReadFileView } from '../components/ReadFileView.js';
import { ShellView } from '../components/ShellView.js';
import { theme } from '../theme.js';
import { detectLanguage, type HighlightLanguage } from './code-highlight.js';
import { displayFilePath, parseFileMutationDiff, parseFileReadResult } from './file-diff.js';
import { parseShellResult } from './shell-result.js';
import { formatToolActivity } from './tool-display.js';
import type { AddStaticFn } from './transcript.js';
import { isNotification } from '../tools/notify.js';
import { parseProgress } from '../tools/progress.js';

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === 'object') return args;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort file hint from the tool arguments. */
function codeHint(args: string | Record<string, unknown> | undefined): string | undefined {
  const parsed = parseArgs(args);
  if (!parsed) return undefined;
  for (const key of ['file_path', 'path', 'filename', 'file']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Only multi-line, clearly code-like results get a full code box. */
function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 4000) return false;
  if (trimmed.split('\n').length < 3) return false;
  return /(?:=|\{|\}|=>|\bfunction\b|\bdef\b|\bimport\b|\bexport\b|\/\/|^\s*#{1,6}\s)/m.test(trimmed);
}

function toolCodeLanguage(args: string | Record<string, unknown> | undefined, result: string): {
  language: HighlightLanguage;
  hint?: string;
} {
  const hint = codeHint(args);
  if (hint) return { language: detectLanguage(hint), hint };
  return { language: /^\s*[{[]/.test(result.trim()) ? 'json' : 'text' };
}

/**
 * Render one tool result into the transcript. File mutations and reads keep
 * their existing cards; bash gets an expandable shell card; code-ish results
 * get a bounded highlighted box; everything else keeps the compact one-line
 * activity row.
 */
export function addToolResultView(
  addStatic: AddStaticFn,
  toolName: string,
  toolArgs: string | Record<string, unknown> | undefined,
  rawResult: string
): void {
  // Notifications and progress reports get dedicated, colorful cards instead
  // of being flattened into a generic one-line activity row.
  if (isNotification(rawResult)) {
    const message = rawResult.replace(/^NOTIFY:\s*/i, '');
    addStatic(
      <Box paddingX={2} marginBottom={1}>
        <Text color={theme.info} bold>🔔 </Text>
        <Text color={theme.text}>{message}</Text>
      </Box>
    );
    return;
  }
  const progressInfo = parseProgress(rawResult);
  if (progressInfo) {
    const filled = Math.round((progressInfo.percent / 100) * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    addStatic(
      <Box paddingX={2} marginBottom={1}>
        <Text color={theme.accent} bold>{`⏵ ${bar} ${progressInfo.percent}%`}</Text>
        {progressInfo.label ? <Text color={theme.muted}> {progressInfo.label}</Text> : null}
      </Box>
    );
    return;
  }

  const fileDiff = parseFileMutationDiff(toolName, toolArgs, rawResult);
  if (fileDiff) {
    addStatic(
      <DiffView
        header={fileDiff.header}
        diff={fileDiff.diff}
        filePath={fileDiff.filePath}
        operation={fileDiff.operation}
      />
    );
    return;
  }

  const fileRead = parseFileReadResult(toolName, toolArgs, rawResult);
  if (fileRead) {
    addStatic(<ReadFileView {...fileRead} />);
    return;
  }

  const shell = parseShellResult(toolName, toolArgs, rawResult);
  if (shell) {
    const collapsed = <ShellView {...shell} expanded={false} />;
    const expanded = <ShellView {...shell} expanded />;
    addStatic(collapsed, { collapsed, expanded });
    return;
  }

  const code = toolCodeLanguage(toolArgs, rawResult);
  if (code.language !== 'text' && looksLikeCode(rawResult)) {
    addStatic(
      <CodeBlock
        code={rawResult}
        language={code.language}
        filename={code.hint ? displayFilePath(code.hint) : undefined}
        showHeader
        showLineNumbers
        maxRows={8}
      />
    );
    return;
  }

  const parsedArgs = parseArgs(toolArgs);
  const toolDisplay = parsedArgs ? formatToolActivity(toolName, parsedArgs) : toolName;
  const compactResult = rawResult.replace(/\s+/g, ' ').trim().slice(0, 180);
  const isError = /^(Error\b|File not found\b|Operation cancelled\b)/i.test(rawResult.trim());

  addStatic(
    <Box paddingX={2} marginBottom={1}>
      <Text color={isError ? theme.error : undefined} dimColor={!isError}>
        {'▶ '}
        {toolDisplay}
        {': '}
        {compactResult}
      </Text>
    </Box>
  );
}

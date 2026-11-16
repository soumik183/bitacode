import React from 'react';
import { Box, Text } from 'ink';
import { DiffView } from '../components/DiffView.js';
import { ReadFileView } from '../components/ReadFileView.js';
import { ShellView } from '../components/ShellView.js';
import { theme } from '../theme.js';
import { parseFileMutationDiff, parseFileReadResult } from './file-diff.js';
import { parseShellResult } from './shell-result.js';
import { formatToolActivity } from './tool-display.js';
import type { AddStaticFn } from './transcript.js';

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

/**
 * Render one tool result into the transcript. File mutations and reads keep
 * their existing cards; bash gets an expandable shell card; everything else
 * keeps the compact one-line activity row.
 */
export function addToolResultView(
  addStatic: AddStaticFn,
  toolName: string,
  toolArgs: string | Record<string, unknown> | undefined,
  rawResult: string
): void {
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

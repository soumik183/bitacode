/**
Main UI component — the heart of Bitacode's terminal interface.

Renders the chat loop, tool call feedback, approval prompts,
and cost/usage info. All heavy logic lives in `agentic-loop.ts`;
this file is purely presentation + state wiring.

Layout:
- The transcript is one measured flow: replayed messages, then the live
  thinking block and streaming tail directly under the message that caused
  them. No footer-pinned thought with a gap above it.
- The composer and status line stay fixed below the scrollable viewport.
- Pickers, settings and critical prompts use one Dialog card, centred
  horizontally and anchored near the top of a clean canvas.
- On exit (ctrl+c or /quit) the session is saved and a resume card is printed
  after Ink unmounts.
*/

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout, measureElement } from 'ink';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { LeftBar } from './components/LeftBar.js';
import { Palette, SLASH_COMMANDS, type PaletteItem } from './components/Palette.js';
import { Dialog, DialogList, dialogInnerWidth, type DialogItem } from './components/Dialog.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { AskPrompt, askPromptHint } from './components/AskPrompt.js';
import { ApiKeyPrompt } from './components/ApiKeyPrompt.js';
import { EntryErrorBoundary } from './components/EntryErrorBoundary.js';
import { UsageDisplay } from './components/UsageDisplay.js';
import { LiveStatus, type LiveActivity } from './components/LiveStatus.js';
import { DiffView } from './components/DiffView.js';
import { ThinkingBlock, thinkingBlockHeight } from './components/ThinkingBlock.js';
import { ThinkingArchive } from './components/ThinkingArchive.js';
import { TodoPanel, todoPanelRows } from './components/TodoPanel.js';
import {
  SubAgentActivity,
  subAgentActivityRows,
  subAgentActivitySummary,
  upsertSubAgentActivity,
  type SubAgentEventFields,
} from './components/SubAgentActivity.js';
import { SubAgentDetail } from './components/SubAgentDetail.js';
import {
  listSubAgentRuns,
  loadSubAgentRun,
  type SubAgentRunRecord,
  type SubAgentRunSummary,
} from './utils/subagent-store.js';
import { ThemeProvider, useTheme, THEME_NAMES, getTheme, registerCustomTheme, type Theme, type ThemeName } from './theme/index.js';
import {
  loadSettings,
  saveSettings,
  STATUS_LINE_ITEMS,
  type UiSettings,
  type ApprovalMode,
} from './settings.js';
import { VARIANTS } from './variants.js';
import { PromptInput, charWidth } from './components/PromptInput.js';
import { createProviderClient } from './providers/client.js';
import { answerLocally } from './utils/local-answers.js';
import { detectTerminalProfile } from './utils/terminal.js';
import { createDecodeSpeedTracker } from './utils/decode-speed.js';
import { loadHooks, runHooks, type HookCommand } from './utils/hooks.js';
import { isProjectTrusted, trustProject } from './utils/project-trust.js';
import { loadEffectiveRules } from './commands/permissions.js';
import { mergeRuleSets, describeRuleSet, type PermissionRuleSet } from './utils/permission-rules.js';
import { loadCustomCommands, expandCommand, type CustomCommand } from './utils/custom-commands.js';
import { loadPlugins } from './utils/plugins.js';
import { loadHistory, appendHistory, HistoryNavigator } from './utils/input-history.js';
import { summarizePaste } from './utils/paste.js';
import { findMentionToken, applyMention, listMentionCandidates } from './utils/mentions.js';
import { collectMentionCandidates } from './utils/mention-candidates.js';
import { readGitBranch } from './utils/git-branch.js';
import { openInBrowser, REPO_URL, BUG_REPORT_URL } from './utils/browser.js';
import { searchSessions } from './utils/session-search.js';
import { createInbox } from './utils/session-inbox.js';
import { discoverAgents, renderAgentCatalog } from './agents.js';
import {
  formatTaskNotification, listBackgroundJobs, stopAllBackgroundJobs,
} from './utils/background-jobs.js';
import { deleteDraft, listDrafts, popDraft, saveDraft } from './utils/draft-stash.js';
import { createConfigWatcher, defaultWatchTargets } from './utils/config-watch.js';
import { discoverThemeFiles } from './theme/discovery.js';
import { resolveKeybind, type KeyAction } from './utils/keybinds.js';
import { pickerClickIndex } from './utils/picker-click.js';
import { splitPathTokens } from './utils/path-highlight.js';
import { commonPrefix } from './utils/completion.js';
import { fuzzyFilter } from './utils/fuzzy.js';
import { formatHints, type HintContext } from './utils/hints.js';
import { renderShortcutPanel } from './utils/shortcuts.js';
import { detectChecks, runChecks, renderCheckReport } from './utils/autoverify.js';
import { collectDoctorReport, renderDoctorReport } from './utils/doctor.js';
import { appendJournal } from './utils/session-journal.js';
import { beginTurn, endTurn, resolveRewind, checkpointsForRewind, truncateTurns } from './utils/turn-snapshots.js';
import { getWorkingCheckpoint, clearWorkingCheckpoint } from './utils/working-checkpoint.js';
import { formatMemoryList, listMemory, addMemory, forgetMemory } from './utils/memory.js';
import { handleToolCall as runToolCall } from './tools/index.js';

import { OpenAI } from 'openai';
import { getRuntimeConfigPath, readConfig, resolveApiKey, writeActiveSelection, writeProviderApiKey, ensureUserConfigDirectory, detectConfigFromEnvironment, writeConfig, type Config } from './config.js';
import { getActiveRuntimeConfigPath, loadRuntimeConfig } from './runtime-config.js';
import { getAllProviders, getProvider, getModelDetails, getModelPricing, getRequestDefaultParams } from './providers/index.js';
import {
  runAgenticLoop,
  initializeMessages,
  type Message,
  type AgentEvent,
} from './agentic-loop.js';
import {
  setDangerouslySkipPermissions,
  setApprovalMode,
  setApprovalHandler,
  clearApprovalHandler,
  setAskHandler,
  setFormHandler,
  clearFormHandler,
  setToolGroups,
  recordSubAgentStatus,
  handleToolCall,
  setPlanMode,
} from './tools/index.js';
import type { ApprovalRequest, ApprovalResponse } from './utils/approval.js';
import type { AskOption, AskRequest, AskResponse } from './tools/ask.js';
import type { FormRequest, FormResponse } from './tools/form.js';
import { setLogLevel, LogLevel, initLogFile, logger, getRecentLogs } from './utils/logger.js';
import {
  createSession,
  deleteSession,
  ensureSystemPromptAtTop,
  hasConversationMessages,
  saveSession,
  loadSession,
  listSessions,
  generateTitle,
  formatSessionAge,
  type Session,
  type SubAgentActivity as SubAgentActivityData,
} from './sessions.js';
import { clearTodos, getTodosForSession, setTodosForSession, type TodoItem } from './tools/todo.js';
import { stopAllProcesses } from './tools/process.js';
import { initializeMcp, closeMcp } from './mcp.js';
import { generateSystemPrompt } from './system-prompt.js';
import { renderFormattedText, normalizeTranscriptText } from './utils/format-message.js';
import { formatContextWindow, getCachedContextWindow, listProviderModels, prefetchProviderModels } from './utils/provider-models.js';
import { addToolResultView } from './utils/tool-result-view.js';
import { itemAtViewportRow, type AddStaticFn } from './utils/transcript.js';
import { getLeftMousePress, getWheelDelta, isMouseReport, stripMouseReports } from './utils/mouse.js';
import { nextThinkingExpansion } from './utils/thinking-expansion.js';
import { formatSessionExit } from './utils/session-exit-format.js';
import { formatUpdateExit } from './utils/update-exit-format.js';
import { formatInstallFailure } from './utils/cli-update-format.js';
import { checkForUpdate, installUpdate } from './utils/version-check.js';
import {
  clampScroll,
  maxScrollOffset,
  scrollAfterGrowth,
  sliceItemsToWindow,
  visibleRowWindow,
} from './utils/scroll.js';
import {
  clampIndex,
  composerTextWidth,
  finiteDim,
  frameRows,
  resolveLayout,
  splitLiveArea,
  transcriptFillerRows,
} from './utils/layout.js';
import { resolveItemRows } from './utils/transcript-rows.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from './utils/scrollbar.js';
import { useAgentEventHandler, type AssistantMessageRef, type StreamingBuffer, type InlineThreadError } from './hooks/useAgentEventHandler.js';

// Static items archive completed messages to scrollback so users can scroll
// up to read history while new AI content streams in the live area.
interface StaticItem {
  id: string; // Unique key for React
  node: React.ReactNode;
  /** Alternate nodes for click-to-expand transcript cards. */
  toggle?: {
    collapsed: React.ReactNode;
    expanded: React.ReactNode;
  };
  expanded?: boolean;
}

// Live conversation ids. Thinking and the streaming tail are appended to the
// transcript flow under stable ids so the measured window can scroll them like
// any archived message (and so a click can still toggle a live thought).
const LIVE_THINKING_ID = '__live_thinking';
const LIVE_STREAM_ID = '__live_stream';
// A streaming tail longer than this is clipped; completed lines already live
// in the transcript, so only the unfinished edge needs to be on screen.
const MAX_LIVE_STREAM_ROWS = 14;

// Keep scrollback rendering light on long sessions and low-memory devices.
const MAX_STATIC_ITEMS = 120;
// Resumed sessions keep their full model context, but replay only the tail to
// scrollback so a huge transcript does not flood the terminal at once.
const MAX_REPLAY_MESSAGES = 100;

function fallbackItemRows(node: React.ReactNode): number {
  if (!node) return 0;
  if (typeof node === 'string' || typeof node === 'number') return 1;
  if (React.isValidElement(node)) {
    const children = (node.props as { children?: unknown }).children;
    if (typeof children === 'string' || typeof children === 'number') {
      return Math.max(1, String(children).split('\n').length);
    }
  }
  return 2;
}

interface StaticEntryProps {
  item: StaticItem;
  columns: number;
  /** Height reporter; the node is passed so the height can be keyed by node. */
  onMeasure: (id: string, rows: number, node: React.ReactNode) => void;
  /** Registers the rendered box so click hit-testing can use real layout. */
  onRef?: (id: string, node: any) => void;
}

/** Renders one transcript row-group and reports its real height for scrolling. */
const StaticEntry = React.memo(({ item, columns, onMeasure, onRef }: StaticEntryProps) => {
  const ref = React.useRef<any>(null);
  const setRef = React.useCallback(
    (node: any) => {
      ref.current = node;
      onRef?.(item.id, node);
    },
    [item.id, onRef]
  );
  React.useEffect(() => {
    if (!ref.current) return;
    const height = measureElement(ref.current).height;
    if (height > 0) onMeasure(item.id, height, item.node);
  }, [item.id, item.node, columns, onMeasure]);

  return (
    <Box ref={setRef} flexDirection="column" flexShrink={0}>
      <EntryErrorBoundary>{item.node}</EntryErrorBoundary>
    </Box>
  );
});


// Empty-chat wordmark. It is rendered live (not into scrollback) so it can
// disappear the moment the first message arrives.
const SPLASH_LINES = [
  '█▄▄ █ ▀█▀ ▄▀█ █▀▀ █▀█ █▀▄ █▀▀',
  '█▄█ █  █  █▀█ █▄▄ █▄█ █▄▀ ██▄',
];

const Splash: React.FC = () => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={theme.accent} bold>
        {SPLASH_LINES[0]}
      </Text>
      <Text color={theme.accent} bold>
        {SPLASH_LINES[1]}
      </Text>
      <Box height={1} />
      <Text color={theme.muted}>a small, readable agent</Text>
      <Box height={1} />
      <Text color={theme.dim}>type a request · / commands</Text>
    </Box>
  );
};

// First-run guidance lives in the main screen, never in a blocking wizard.
const SETUP_HINT = 'No provider configured — type /provider to choose one';
const API_MISSING_HINT = 'API key missing — type /provider to select a provider and add a key.';

/**
 * Content width for an archived message: the terminal minus the transcript
 * gutter (2 each side) and the scrollbar rail (1 column). Tables and long
 * inline spans are scaled to this, so a wide table can never wrap and smear
 * when the user scrolls back to it.
 */
function transcriptTextWidth(columns?: number): number {
  if (!columns || !Number.isFinite(columns)) return 0;
  return Math.max(20, Math.floor(columns) - 5);
}

function printMessageToScrollback(
  addStatic: AddStaticFn,
  role: 'user' | 'assistant',
  text: string,
  palette: Theme,
  columns?: number
): void {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) {
    addStatic(<Box height={1} />);
    return;
  }
  if (role === 'user') {
    addStatic(
      <Box flexDirection="column" paddingX={2} marginBottom={1}>
        <Box
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderLeftColor={palette.userBorder}
          paddingLeft={1}
        >
          <Text color={palette.userText}>
            {splitPathTokens(normalized).map((span, index) => (
              <Text key={index} color={span.path ? palette.accent : palette.userText}>
                {span.text}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
    );
    return;
  }
  // Fallback is assistant, render with Markdown formatting (bold, italic)
  addStatic(
    <Box paddingX={2} paddingBottom={1}>
      <Text wrap="wrap">{renderFormattedText(normalized, transcriptTextWidth(columns), palette)}</Text>
    </Box>
  );
}

function replayOneMessage(
  addStatic: AddStaticFn,
  message: Message,
  toolCallsById: Map<string, { name: string; args?: string | Record<string, unknown> }>,
  palette: Theme,
  columns?: number
): void {
  const msgAny = message as any;
  if (message.role === 'system') return;
  // Persisted reasoning is replayed as an expandable thought card above the
  // answer it produced, matching the live session's scrollback order.
  if (msgAny.role === 'assistant' && typeof msgAny.reasoning === 'string' && msgAny.reasoning.trim()) {
    const collapsed = <ThinkingArchive text={msgAny.reasoning} elapsedMs={0} columns={columns} />;
    const expanded = <ThinkingArchive text={msgAny.reasoning} elapsedMs={0} columns={columns} expanded />;
    addStatic(collapsed, { collapsed, expanded });
  }
  if (message.role === 'user' && typeof message.content === 'string') {
    printMessageToScrollback(addStatic, 'user', message.content, palette, columns);
    return;
  }
  if (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  ) {
    printMessageToScrollback(addStatic, 'assistant', message.content, palette, columns);
    return;
  }
  if (message.role === 'tool') {
    const savedCall = msgAny.tool_call_id ? toolCallsById.get(msgAny.tool_call_id) : undefined;
    const toolName = typeof msgAny.name === 'string' && msgAny.name ? msgAny.name : savedCall?.name || 'tool';
    const toolArgs = msgAny.args ?? savedCall?.args;
    addToolResultView(addStatic, toolName, toolArgs, String(msgAny.content || ''), palette, columns);
  }
}

function replayMessagesToScrollback(
  addStatic: AddStaticFn,
  messages: Message[],
  palette: Theme,
  maxMessages = messages.length,
  columns?: number
): void {
  const omitted = Math.max(0, messages.length - maxMessages);
  const visible = omitted > 0 ? messages.slice(omitted) : messages;

  // Saved tool results only carry tool_call_id, so recover the tool name and
  // arguments from the assistant message that requested them. Without this a
  // resumed transcript renders every read/write/edit as "▶ tool".
  const toolCallsById = new Map<string, { name: string; args?: string | Record<string, unknown> }>();
  for (const message of messages) {
    const msgAny = message as any;
    if (msgAny.role !== 'assistant' || !Array.isArray(msgAny.tool_calls)) continue;
    for (const call of msgAny.tool_calls) {
      if (call?.id && call.function?.name) {
        toolCallsById.set(call.id, { name: call.function.name, args: call.function.arguments });
      }
    }
  }

  if (omitted > 0) {
    addStatic(
      <Box paddingX={2}>
        <Text color={palette.dim}>
          … {omitted} earlier message{omitted === 1 ? '' : 's'} kept in model context, not replayed …
        </Text>
      </Box>
    );
  }
  for (const message of visible) {
    try {
      replayOneMessage(addStatic, message, toolCallsById, palette, columns);
    } catch (err: any) {
      // One malformed saved message must not abort the rest of the transcript.
      logger.warn('Skipped malformed session message during replay', {
        error: err?.message ?? String(err),
        role: (message as any)?.role,
      });
      addStatic(
        <Box paddingX={2} marginBottom={1}>
          <Text color={palette.dim}>… one saved message could not be displayed …</Text>
        </Box>
      );
    }
  }
  if (messages.length > 0) {
    addStatic(<Box height={1} />);
  }
}

/** Flush one compact card summarising a resumed session's child agents. */
function replaySubAgentActivities(
  addStatic: AddStaticFn,
  activities: SubAgentActivityData[],
  palette: Theme
): void {
  if (activities.length === 0) return;
  addStatic(
    <Box paddingX={2} marginBottom={1}>
      <Text color={palette.muted}>{`▣ ${subAgentActivitySummary(activities)}`}</Text>
    </Box>
  );
}

/** Display cells of a string (CJK/emoji count as two, combining marks as zero). */
function displayCells(text: string): number {
  let cells = 0;
  for (const ch of Array.from(text)) cells += charWidth(ch);
  return cells;
}

// Limit streaming text to the free viewport rows. Count WRAPPED rows, not
// logical lines: one long token with no newline can still wrap to many rows
// and grow the frame (which pushes the composer off screen).
function clipToRows(text: string, maxRows: number, columns: number): string {
  const budget = Math.max(1, maxRows);
  const width = Math.max(1, columns);
  const lines = text.split('\n');
  const kept: string[] = [];
  let rows = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const lineRows = Math.max(1, Math.ceil(displayCells(line) / width));
    if (rows + lineRows > budget) {
      // A single line longer than the whole viewport (a reply with no breaks,
      // or a minified blob) must be clipped too, or the live area renders the
      // entire string every frame and pushes the composer off screen.
      if (kept.length === 0) {
        const chars = Array.from(line);
        const cellBudget = budget * width;
        let used = 0;
        let count = 0;
        for (let i = chars.length - 1; i >= 0; i--) {
          const w = charWidth(chars[i]);
          if (used + w > cellBudget) break;
          used += w;
          count++;
        }
        kept.unshift(chars.slice(Math.max(0, chars.length - Math.max(1, count))).join(''));
      }
      break;
    }
    rows += lineRows;
    kept.unshift(line);
  }
  return (kept.length > 0 ? kept : ['']).join('\n');
}

/** Wrapped display rows for a block of text at a fixed column width. */
function wrappedRowCount(text: string, width: number): number {
  const cols = Math.max(1, Math.floor(width));
  return text
    .split('\n')
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(displayCells(line) / cols)),
      0
    );
}

/**
 * Turn an Ink input/key pair into a canonical `ctrl+…` / `tab` / `esc` token so
 * a configured keybinding can be compared with it. Ink reports function keys
 * and some control bytes as raw `input` strings, hence the normalisation.
 */
function canonicalPressed(input: string, key: {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  tab?: boolean;
  escape?: boolean;
  return?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  f12?: boolean;
}): string {
  const mods = `${key.ctrl ? 'ctrl+' : key.meta ? 'alt+' : key.shift ? 'shift+' : ''}`;
  if (key.tab) return `${mods}tab`;
  if (key.escape) return `${mods}esc`;
  if (key.return) return `${mods}enter`;
  if (key.upArrow) return `${mods}up`;
  if (key.downArrow) return `${mods}down`;
  if (key.leftArrow) return `${mods}left`;
  if (key.rightArrow) return `${mods}right`;
  if (key.pageUp) return `${mods}pageup`;
  if (key.pageDown) return `${mods}pagedown`;
  if (key.home) return `${mods}home`;
  if (key.end) return `${mods}end`;
  if (key.f12) return `${mods}f12`;
  const ch = input === '\x1c' ? ',' : input === '\x1f' ? '/' : input;
  if (!ch) return '';
  // F12 arrives as `ESC [ 2 4 ~` on most terminals.
  if (ch === '\x1b[24~') return `${mods}f12`;
  return `${mods}${ch.toLowerCase()}`;
}

/**
 * Register user palettes synchronously at startup. Called from App before
 * ThemeProvider resolves a palette, so a saved `custom` selection paints with
 * its real colours on the very first frame. `settings.themePath` wins over
 * discovery, which otherwise takes the first alphabetical file in its folder.
 */
function registerUserThemes(themePath?: string): void {
  try {
    const dir = themePath ? dirname(themePath) : undefined;
    const found = discoverThemeFiles({ extraDirs: dir ? [dir] : [] });
    if (!found.ok) return;
    const exact = themePath
      ? found.value.find((file) => file.path === themePath || basename(file.path) === basename(themePath))
      : undefined;
    const ordered = exact ? [exact, ...found.value.filter((file) => file !== exact)] : found.value;
    for (const file of ordered) {
      if (registerCustomTheme('custom', file.raw)) break;
    }
  } catch {
    // A broken theme file must never stop the TUI from starting.
  }
}

// Tools that can change files or system state. In plan mode their tool_call
// events are shown as blocked instead of being forwarded to the transcript.
const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'multiedit', 'delete', 'rename',
  'move', 'copy', 'mkdir', 'git_add', 'git_commit', 'git_stash', 'bash',
  'start_process', 'write_process_stdin', 'stop_process', 'kill', 'watch',
  'background',
]);

const PLAN_MODE_NOTE =
  'PLAN MODE: Do not modify files or run state-changing tools. Output a plan only, with no tool calls.';

/** Recover the displayable text of a transcript card for search / copy. */
function nodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/** A minimal, conservative "is this streamed text a diff?" check. */
function looksLikeDiff(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  if (lines.some((line) => /^(@@|diff --git|--- |\+\+\+ )/.test(line))) return true;
  const adds = lines.filter((line) => line.startsWith('+')).length;
  const removes = lines.filter((line) => line.startsWith('-')).length;
  return adds > 0 && removes > 0 && adds + removes >= 2;
}

/** Best-effort file path from a serialized tool-call argument object. */
function extractPathFromArgs(args: string | undefined): string | undefined {
  if (!args) return undefined;
  let parsed: any;
  try {
    parsed = typeof args === 'string' ? JSON.parse(args) : args;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  for (const key of ['file_path', 'path', 'filename', 'file', 'destination', 'source']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (Array.isArray(parsed.edits)) {
    for (const edit of parsed.edits) {
      if (typeof edit?.file_path === 'string' && edit.file_path.trim()) return edit.file_path.trim();
    }
  }
  if (typeof parsed.patch === 'string') {
    const match = parsed.patch.match(/^\+\+\+ b\/(.+)$/m);
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Best-effort clipboard write; never throws, returns after at most 2 s. */
function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve) => {
    const { cmd, args } = process.platform === 'android'
      ? { cmd: 'termux-clipboard-set', args: [] as string[] }
      : process.platform === 'darwin'
        ? { cmd: 'pbcopy', args: [] as string[] }
        : process.platform === 'win32'
          ? { cmd: 'clip', args: [] as string[] }
          : { cmd: 'xclip', args: ['-selection', 'clipboard'] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish();
      }, 2000);
      child.on('error', finish);
      child.on('close', finish);
      child.stdin.on('error', finish);
      child.stdin.end(text);
    } catch {
      finish();
    }
  });
}

// ─── Props ───
export interface AppProps {
  dangerouslySkipPermissions?: boolean;
  logLevel?: string;
  sessionId?: string;
  /** Optional one-line update hint shown in the live area when idle. */
  updateNotice?: string;
  /** Installed package version, used by /update to fetch npm releases. */
  version?: string;
}

type AppContentProps = AppProps & {
  settings: UiSettings;
  setSettings: React.Dispatch<React.SetStateAction<UiSettings>>;
};

// ─── Help text derived from slash commands ───
// Shortcuts accept ctrl OR alt (Ink reports Alt via `key.meta`). Text-editing
// keys a/e/u/w belong to PromptInput, so they are deliberately absent here.
const APPROVAL_MODES: ApprovalMode[] = ['manual', 'acceptEdits', 'auto', 'yolo'];

function buildHelpText(approvalMode: ApprovalMode): string {
  // Keep the panel compact: the live area is height-capped so the composer and
  // footer can never be pushed off screen.
  // Wrap at 72 columns: a single long line would be clipped at 100 columns
  // and push the key legend out of the help panel.
  const commandLines: string[] = [];
  let line = '  ';
  for (const name of SLASH_COMMANDS.map((cmd) => cmd.name)) {
    if (line.length + name.length + 1 > 72) {
      commandLines.push(line.trimEnd());
      line = '  ';
    }
    line += `${name} `;
  }
  commandLines.push(line.trimEnd());
  return [
    'Commands:',
    ...commandLines,
    '  /session delete <id> - delete a saved session',
    '',
    'Keys (ctrl or alt):',
    '  n new · s sessions · m model · p provider · v variant',
    '  h help · k clear · l clear chat · t thinking · b/f scroll',
    '  tab plan · ^r retry · ^e collapse · ^y copy · alt+↑ edit',
    '  , settings · / help · q sessions · esc close/cancel',
    `  Approval mode: ${approvalMode} (ctrl+, or alt+, to change)`,
  ].join('\n');
}

const SETTING_KEYS = ['animations', 'mouseClicks', 'approvalMode', 'theme', 'statusLine'] as const;

// Short intents shown beside each palette in the theme picker. Keep them brief
// so names and swatches stay readable on narrow terminals.
const THEME_INTENTS: Record<ThemeName, string> = {
  black: 'graphite canvas · warm gold',
  midnight: 'deep navy · violet, for night work',
  dark: 'neutral slate · confident blue',
  light: 'paper white · ink, for daylight',
  sand: 'warm notebook · terracotta',
  moss: 'forest calm · olive, low glare',
  'high-contrast': 'pure black/white · maximum contrast',
  custom: 'user theme',
};

function buildClient(config: Config, apiKeyOverride?: string): OpenAI {
  // Delegates to the shared factory so headless mode and the TUI cannot drift.
  return createProviderClient(config, apiKeyOverride ? { apiKey: apiKeyOverride } : {});
}

interface ApiKeyRequest {
  providerId: string;
  providerName: string;
  path: string;
  error: string | null;
  busy: boolean;
}

// ─── Main App ───
const AppContent: React.FC<AppContentProps> = ({
  dangerouslySkipPermissions = false,
  logLevel,
  sessionId,
  updateNotice,
  version,
  settings,
  setSettings,
}) => {
  const theme = useTheme();
  const { exit } = useApp();
  const { stdout } = useStdout();
  // A zoom burst can briefly report 0/undefined/NaN dimensions; clamp once at
  // the source so every downstream width/height stays a finite positive int.
  const [dims, setDims] = useState({
    columns: finiteDim(stdout?.columns, 80),
    rows: finiteDim(stdout?.rows, 24),
  });
  // Bumped on every resize event so the viewport is re-measured even when the
  // clamped dims did not change (a zoom step can settle without a dim change).
  const [resizeTick, setResizeTick] = useState(0);
  const { columns, rows } = dims;
  // One row shorter than the terminal. Rendering at exactly `rows` makes Ink
  // take its full-screen path (`clearTerminal` + full repaint) on every frame,
  // which is the blinking seen while scrolling and streaming.
  const frameHeight = frameRows(rows);
  // Keep the configure wizard inside the frame on short terminals (Select caps
  // at five visible options, but the surrounding text still needs a bound).

  // ─── Static scrollback state ───
  // Each item is rendered once by <Static> and permanently flushed to scrollback.
  // staticCounterRef generates unique IDs (s1, s2, s3...) for React keys.
  const staticCounterRef = useRef(0);
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);
  // Transcript scroll: rows above the bottom of the visible viewport.
  const [userScroll, setUserScroll] = useState(0);
  const [viewportRows, setViewportRows] = useState(Math.max(1, rows - 8));
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  // Restored sessions are measured off-screen before the transcript is shown,
  // so a tall replay can never squeeze or overlap cards on the first frame.
  const [measuringTranscript, setMeasuringTranscript] = useState(false);
  const viewportRef = useRef<any>(null);
  const entryNodesRef = useRef<Map<string, any>>(new Map());
  const registerEntryNode = useCallback((id: string, node: any) => {
    if (node) entryNodesRef.current.set(id, node);
    else entryNodesRef.current.delete(id);
  }, []);
  const addStatic = useCallback((node: React.ReactNode, toggle?: StaticItem['toggle']) => {
    staticCounterRef.current += 1;
    const id = `s${staticCounterRef.current}`;
    // Bound the React tree: the terminal keeps printed scrollback, but old
    // nodes should not accumulate in memory on long sessions.
    setStaticItems((prev) => {
      const next = [...prev, { id, node, toggle, expanded: false }];
      return next.length > MAX_STATIC_ITEMS ? next.slice(next.length - MAX_STATIC_ITEMS) : next;
    });
  }, []);
  const toggleStaticItem = useCallback((id: string) => {
    setStaticItems((prev) =>
      prev.map((item) => {
        if (item.id !== id || !item.toggle) return item;
        const expanded = !item.expanded;
        return {
          ...item,
          expanded,
          node: expanded ? item.toggle.expanded : item.toggle.collapsed,
        };
      })
    );
  }, []);
  // Heights are cached per rendered node, not only per transcript id. A card
  // keeps two prebuilt nodes (collapsed and expanded); keying by node means a
  // collapse can reuse the height that node had before it was expanded instead
  // of waiting for a re-measure. Without this the transcript kept reserving the
  // expanded height after a click, leaving a tall blank block behind.
  const nodeHeightsRef = useRef<WeakMap<object, number>>(new WeakMap());
  const nodeHeight = useCallback((node: React.ReactNode): number | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    return nodeHeightsRef.current.get(node as object);
  }, []);
  const handleMeasureItem = useCallback((id: string, rows: number, node?: React.ReactNode) => {
    if (node && typeof node === 'object') nodeHeightsRef.current.set(node as object, rows);
    setMeasuredHeights((prev) => (prev[id] === rows ? prev : { ...prev, [id]: rows }));
  }, []);

  // A restored transcript is fully measured before it is displayed. The timer
  // is a safety net for a row that never reports a height (for example, an
  // empty spacer), so a bad entry can never leave the UI stuck on "restoring".
  useEffect(() => {
    if (!measuringTranscript) return;
    if (
      staticItems.length > 0 &&
      staticItems.every((item) => measuredHeights[item.id] !== undefined)
    ) {
      setMeasuringTranscript(false);
    }
  }, [measuringTranscript, staticItems, measuredHeights]);

  useEffect(() => {
    if (!measuringTranscript) return;
    const timer = setTimeout(() => setMeasuringTranscript(false), 2000);
    return () => clearTimeout(timer);
  }, [measuringTranscript]);

  // staticItems is capped at MAX_STATIC_ITEMS; drop measurements for entries
  // that have scrolled out of the React tree so the map cannot grow forever.
  useEffect(() => {
    const keep = new Set(staticItems.map((item) => item.id));
    setMeasuredHeights((prev) => {
      const ids = Object.keys(prev);
      if (ids.every((id) => keep.has(id))) return prev;
      const next: Record<string, number> = {};
      for (const id of ids) if (keep.has(id)) next[id] = prev[id];
      return next;
    });
  }, [staticItems]);

  // Core state
  const [config, setConfig] = useState<Config | null>(null);
  const [completionMessages, setCompletionMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  // Wrapped rows the composer currently renders. The layout reserves them so a
  // multi-line prompt never covers the transcript or the footer.
  const [composerRows, setComposerRows] = useState(1);
  // Wall-clock start of the current busy spell, plus a shared 1 s ticker so the
  // activity strip can count seconds without re-rendering on every token.
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [busyClock, setBusyClock] = useState(() => Date.now());
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // Decode rate is measured from delta length vs. wall clock, so it stays
  // honest when the provider bursts tokens in uneven chunks.
  const [decodeTps, setDecodeTps] = useState<string | null>(null);
  const decodeRef = useRef({ tracker: createDecodeSpeedTracker(), length: 0, shown: null as string | null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpMessage, setHelpMessage] = useState<string | null>(null);
  const [threadErrors, setThreadErrors] = useState<InlineThreadError[]>([]);
  const [initialized, setInitialized] = useState(false);

  // Build vs plan mode. Tab toggles it; plan mode discourages mutations in the
  // prompt and blocks mutating tool calls from reaching the transcript.
  const [mode, setMode] = useState<'build' | 'plan'>('build');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Enforce the mode at the tool dispatcher, below the approval layer, so
  // auto/yolo cannot mutate files while planning.
  useEffect(() => {
    setPlanMode(mode === 'plan');
    return () => setPlanMode(false);
  }, [mode]);
  // `?` shortcut overlay and F12 log panel are non-modal: they never steal
  // focus, and are hidden whenever a dialog owns the frame.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutGuardRef = useRef(false);
  const [showErrorPanel, setShowErrorPanel] = useState(false);
  // Live one-line hint/toast (retry, copy, background task completion, …).
  const [toast, setToast] = useState<string | null>(null);
  const toastActiveRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToastAtRef = useRef(0);
  // /find filters scrollback by the text extracted from each card.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  // Last submitted user text, used by Ctrl+R (retry) and Alt+Up (edit).
  const lastSubmitRef = useRef<string | null>(null);
  // Ink can keep an older prop closure in PromptInput's input handler. Read the
  // live draft through a ref so palette/history routing always sees '/' when it
  // is actually on screen.
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const composerRowsRef = useRef(composerRows);
  composerRowsRef.current = composerRows;
  // Pending image data URL from /image, attached to the next user message.
  const pendingImageRef = useRef<{ path: string; dataUrl: string } | null>(null);
  // Most recent tool call, used to enrich approval details with a file path.
  const lastToolCallRef = useRef<{ name: string; args?: string } | null>(null);
  // Tool-call ids swallowed in plan mode, so their results are hidden too.
  const blockedToolIdsRef = useRef<Set<string>>(new Set());

  const showToast = useCallback((text: string, throttleMs = 1200) => {
    const now = Date.now();
    if (throttleMs > 0 && toastActiveRef.current && now - lastToastAtRef.current < throttleMs) return;
    toastActiveRef.current = true;
    lastToastAtRef.current = now;
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastActiveRef.current = false;
      setToast(null);
    }, 2500);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  /** Ctrl+L: drop the transcript cards, rewind scroll and repaint the canvas. */
  const clearTranscriptAndRedraw = useCallback(() => {
    setStaticItems([]);
    setUserScroll(0);
    setMeasuringTranscript(false);
    try {
      stdout?.write('\x1b[2J\x1b[H');
    } catch {
      // A closed/unusable stdout must never break the TUI; Ink still redraws
      // from the cleared state on the next frame.
    }
    showToast('Screen cleared', 0);
  }, [stdout, showToast]);

  // User-facing preferences arrive from App; the live reasoning/todo state
  // stays local. The palette comes from ThemeProvider via useTheme() above.
  // Keep the terminal canvas in step with the palette so the row below the
  // Ink frame (and any terminal clearing) uses the same background colour.
  useEffect(() => {
    if (!stdout) return;
    stdout.write(`\x1b]11;${theme.bg}\x07`);
  }, [theme.bg, stdout]);
  const [settingsIndex, setSettingsIndex] = useState<number | null>(null);
  const [thinkingText, setThinkingText] = useState('');
  // Expansion is driven by the provider: reasoning opens the block, and it
  // folds when reasoning ends. There is no preset to start expanded.
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // While reasoning streams in, the block opens automatically so the user can
  // read it live; when the reasoning ends it folds back to a one-line header.
  // This flag records a manual toggle so the auto-expand does not fight it.
  const thinkingPinnedRef = useRef(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
  const [thinkingArchived, setThinkingArchived] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Child-agent activity. Kept as the full record for session persistence;
  // a separate flag drives the compact live panel and its auto-hide timer.
  const [subAgentActivities, setSubAgentActivities] = useState<SubAgentActivityData[]>([]);
  // Mirror for callbacks that run later: reading the state variable there
  // captured the array as it was when the turn started, so a finished sub-agent
  // was saved to disk in its "running" state.
  const subAgentActivitiesRef = useRef<SubAgentActivityData[]>([]);
  subAgentActivitiesRef.current = subAgentActivities;
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(false);
  // Saved child transcripts: list picker + the one currently being inspected.
  const [subagentRuns, setSubagentRuns] = useState<SubAgentRunSummary[]>([]);
  const [subagentLoading, setSubagentLoading] = useState(false);
  const [subagentDetail, setSubagentDetail] = useState<SubAgentRunRecord | null>(null);

  // Input reset key — incremented on submit to force TextInput remount and clear
  const [inputResetKey, setInputResetKey] = useState(0);

  // Palette state: slash-command list, provider/model/variant pickers
  const [commandIndex, setCommandIndex] = useState(0);
  // Ink can deliver Enter with an older `commandIndex` closure; the ref is
  // updated synchronously on every arrow/typing change so Enter selects the
  // row that is actually highlighted.
  const commandIndexRef = useRef(commandIndex);
  commandIndexRef.current = commandIndex;
  const [picker, setPicker] = useState<'model' | 'variant' | 'provider' | 'session' | 'statusLine' | 'theme' | 'subagents' | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [variantId, setVariantId] = useState(settings.variant);
  const [remoteModels, setRemoteModels] = useState<Record<string, PaletteItem[]>>({});
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [keyPrompt, setKeyPrompt] = useState<ApiKeyRequest | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [sessionItems, setSessionItems] = useState<PaletteItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [pendingSessionDelete, setPendingSessionDelete] = useState<{
    id: string;
    label: string;
  } | null>(null);
  // Full provider -> model -> API key wizard, reopened from inside the TUI.

  // Approval state. Each entry carries both settle paths so a session switch
  // or an abort can close the prompt instead of stranding the tool's promise.
  const [pendingAsk, setPendingAsk] = useState<{
    request: AskRequest;
    resolve: (response: AskResponse) => void;
    reject: (reason?: unknown) => void;
    dispose?: () => void;
  } | null>(null);

  const [pendingApproval, setPendingApproval] = useState<{
    request: ApprovalRequest;
    resolve: (response: ApprovalResponse) => void;
    reject: (reason?: unknown) => void;
  } | null>(null);

  // Refs mirror the modal slots: async handlers must see a prompt that opened
  // after their render, and must not let a second prompt overwrite the first.
  const pendingAskRef = useRef<NonNullable<typeof pendingAsk>>(null);
  pendingAskRef.current = pendingAsk;
  const pendingApprovalRef = useRef<NonNullable<typeof pendingApproval>>(null);
  pendingApprovalRef.current = pendingApproval;

  const settleAsk = useCallback((response: AskResponse) => {
    const entry = pendingAskRef.current;
    if (!entry) return;
    pendingAskRef.current = null;
    entry.dispose?.();
    entry.resolve(response);
    setPendingAsk(null);
  }, []);

  const rejectAsk = useCallback((reason?: unknown) => {
    const entry = pendingAskRef.current;
    if (!entry) return;
    pendingAskRef.current = null;
    entry.dispose?.();
    entry.reject(reason ?? new Error('Question cancelled'));
    setPendingAsk(null);
  }, []);

  const settleApproval = useCallback((response: ApprovalResponse) => {
    const entry = pendingApprovalRef.current;
    if (!entry) return;
    pendingApprovalRef.current = null;
    entry.resolve(response);
    setPendingApproval(null);
  }, []);

  const rejectApproval = useCallback((reason?: unknown) => {
    const entry = pendingApprovalRef.current;
    if (!entry) return;
    pendingApprovalRef.current = null;
    entry.reject(reason ?? new Error('Approval cancelled'));
    setPendingApproval(null);
  }, []);

  /** Open one ask/form prompt; reject a duplicate instead of overwriting it. */
  const openAsk = useCallback(
    (request: AskRequest, signal?: AbortSignal) =>
      new Promise<AskResponse>((resolve, reject) => {
        if (pendingAskRef.current) {
          reject(new Error('Another question or form is already open — answer it first.'));
          return;
        }
        if (signal?.aborted) {
          reject(new Error('Question cancelled'));
          return;
        }
        let dispose: (() => void) | undefined;
        const onAbort = () => {
          pendingAskRef.current = null;
          setPendingAsk(null);
          reject(new Error('Question cancelled'));
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
          dispose = () => signal.removeEventListener('abort', onAbort);
        }
        const entry = { request, resolve, reject, dispose };
        pendingAskRef.current = entry;
        setPendingAsk(entry);
      }),
    []
  );

  const openApproval = useCallback(
    (request: ApprovalRequest) =>
      new Promise<ApprovalResponse>((resolve, reject) => {
        if (pendingApprovalRef.current) {
          reject(new Error('Another approval is already open — answer it first.'));
          return;
        }
        const entry = { request, resolve, reject };
        pendingApprovalRef.current = entry;
        setPendingApproval(entry);
      }),
    []
  );

  // Usage state
  const [lastUsage, setLastUsage] = useState<AgentEvent['usage'] | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Active tool tracking — shows which tool is currently executing
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Session state
  const [session, setSession] = useState<Session | null>(null);
  // Mirror of the message array for code that must save outside a render
  // (turn end, quit, autosave). React state lags behind by one commit.
  const completionMessagesRef = useRef<Message[]>([]);

  // OpenAI client ref (stable across renders)
  const clientRef = useRef<OpenAI | null>(null);
  // Invalidates stale /models responses when the picker is reopened or closed.
  const modelFetchSeqRef = useRef(0);
  // Latest search text for async /models responses.
  const modelSearchRef = useRef('');
  const remoteModelsRef = useRef<Record<string, PaletteItem[]>>({});
  const modelCacheTimeRef = useRef<Record<string, number>>({});
  // Whether the transcript on disk matches what the user has seen
  const sessionSavedRef = useRef(false);

  /**
   * Autosave.
   *
   * Sessions used to be written only after a turn reached its final message, so
   * a failed request, an abort or a killed process lost the whole conversation,
   * and a brand-new session never appeared in the picker at all. Mirroring the
   * transcript on a short idle debounce closes both holes: every committed
   * state (including a local `/help`-style answer or a mid-turn error) reaches
   * disk within a second, without writing on every streamed token.
   */
  useEffect(() => {
    completionMessagesRef.current = completionMessages;
    if (!session || !initialized) return;
    if (!hasConversationMessages(completionMessages)) return;
    const targetId = session.id;
    const timer = setTimeout(() => {
      const messages = completionMessagesRef.current;
      if (!hasConversationMessages(messages)) return;
      const snapshot: Session = {
        ...session,
        completionMessages: messages,
        todos: getTodosForSession(targetId),
        title: generateTitle(messages, session.title),
        variant: variantId,
        subAgentActivities: subAgentActivitiesRef.current,
      };
      void saveSession(snapshot)
        .then(() => { sessionSavedRef.current = true; })
        .catch((err) => logger.warn('Autosave failed', { error: String(err) }));
    }, 700);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [completionMessages, session, initialized, variantId]);

  // Session to advertise on exit, and a guard against saving twice on a fast
  // ctrl+c / /quit burst.
  const exitSessionIdRef = useRef<string | null>(null);
  // Set after a successful in-app update so the post-exit screen can explain
  // that the installed build only takes effect on the next launch.
  const exitUpdateRef = useRef<{ from: string; to: string; scope: 'global' | 'local' } | null>(null);
  // Guards against a second `/update` while npm is still installing.
  const updatingRef = useRef(false);
  const exitingRef = useRef(false);
  const assistantMessageRef = useRef<AssistantMessageRef | null>(null);
  // Latest reasoning for the current turn; refs survive stale loop closures.
  const reasoningRef = useRef('');

  // Abort controller for cancelling the current completion
  const abortControllerRef = useRef<AbortController | null>(null);
  // Monotonic run id. /new bumps it so an older run cannot write its results
  // into the new session after being aborted.
  const activeRunRef = useRef(0);
  // Prompts typed while a turn is running are admitted here, not dropped.
  const inboxRef = useRef(createInbox());
  // A queued prompt is acknowledged only after its turn actually starts, so a
  // submit that fails early does not silently lose the user's prompt.
  const queuedDeliveryRef = useRef<{ id: string; sessionId: string } | null>(null);
  const deliveryInFlightRef = useRef(false);
  /** Background jobs whose completion has already been surfaced to the model. */
  const notifiedJobsRef = useRef<Set<string>>(new Set());

  // Buffer for streaming text that accumulates content and flushes complete lines to static
  // This prevents the live streaming area from growing unbounded - complete lines are
  // immediately flushed to <Static>, only the incomplete final line stays in the dynamic frame
  const streamingBufferRef = useRef<StreamingBuffer>({
    unflushedContent: '',
    hasFlushedAnyLine: false,
    lastUiUpdate: 0,
  });

  // Hook for handling agent events
  const handleAgentEvent = useAgentEventHandler({
    addStatic,
    setCompletionMessages,
    setIsStreaming,
    setStreamingText,
    setThinkingText,
    setThinkingArchived,
    setThinkingStartedAt,
    reasoningRef,
    setActiveTool,
    setLastUsage,
    setTotalCost,
    setThreadErrors,
    setError,
    assistantMessageRef,
    streamingBufferRef,
    columns,
  });

  // Wrap the shared event handler so child-agent progress is tracked here
  // (the hook is shared and intentionally unaware of this UI-only state).
  const handleAgentEventWithSubAgents = useCallback(
    (event: AgentEvent) => {
      // Plan mode: hide mutating calls and their results from the transcript.
      if (mode === 'plan' && event.type === 'tool_call' && event.toolCall) {
        if (MUTATING_TOOLS.has(event.toolCall.name)) {
          blockedToolIdsRef.current.add(event.toolCall.id);
          setActiveTool(null);
          addStatic(
            <Box paddingX={2} marginBottom={1}>
              <Text color={theme.error}>{`⛔ Blocked in plan mode: ${event.toolCall.name}`}</Text>
            </Box>
          );
          return;
        }
      }
      if (
        event.type === 'tool_result' &&
        event.toolCall &&
        blockedToolIdsRef.current.has(event.toolCall.id)
      ) {
        blockedToolIdsRef.current.delete(event.toolCall.id);
        return;
      }

      if (event.type === 'tool_call' && event.toolCall) {
        lastToolCallRef.current = { name: event.toolCall.name, args: event.toolCall.args };
      }

      if (event.type === 'sub_agent_iteration') {
        const fields = event as AgentEvent & SubAgentEventFields;
        if (fields.subAgentId) {
          setSubAgentActivities((prev) => upsertSubAgentActivity(prev, fields));
          setShowSubAgentPanel(true);
          // Feed the in-memory registry used by the agent_status tool so the
          // main model can query what its children are doing.
          recordSubAgentStatus(
            fields.subAgentId,
            fields.subAgentTask ?? fields.subAgentLabel ?? '',
            fields.subAgentStatus ?? 'start'
          );
        }
        // A child tool finishing is not the child finishing: only the status
        // field marks completion, so one toast is emitted per sub-agent.
        if (fields.subAgentStatus === 'done') {
          const label = fields.subAgentLabel || fields.subAgentTask || 'Sub-agent';
          showToast(`✓ ${label} finished`);
        }
      }
      if (
        event.type === 'tool_result' &&
        event.toolCall?.name === 'start_process' &&
        !(mode === 'plan' && MUTATING_TOOLS.has('start_process'))
      ) {
        showToast('Background process started');
      }
      handleAgentEvent(event);
    },
    [handleAgentEvent, mode, addStatic, showToast, theme]
  );

  // Finished children linger briefly, then fold away so the panel does not
  // occupy the live area forever. A new activity resets the timer; a still
  // running child keeps the panel pinned.
  const hasActiveSubAgent = subAgentActivities.some((item) => item.status === 'start');
  useEffect(() => {
    if (!showSubAgentPanel || hasActiveSubAgent) return;
    const timer = setTimeout(() => setShowSubAgentPanel(false), 8000);
    return () => clearTimeout(timer);
  }, [showSubAgentPanel, hasActiveSubAgent, subAgentActivities]);

  const didPrintIntroRef = useRef(false);
  // ── Runtime policy: hooks, permission rules, custom commands ──
  // Held in refs because the loop reads them at call time, while the UI only
  // needs to re-render when the command palette changes.
  const hooksRef = useRef<HookCommand[]>([]);
  const rulesRef = useRef<PermissionRuleSet>({ allow: [], ask: [], deny: [], errors: [] });
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  const historyNavigatorRef = useRef<HistoryNavigator | null>(null);
  const terminalProfile = useMemo(() => detectTerminalProfile({ animationsEnabled: settings.animations }), [settings.animations]);
  // A terminal that repaints badly (Apple_Terminal) or not at all (TERM=dumb)
  // gets a static footer instead of an animation loop.
  const animationsEnabled = settings.animations && terminalProfile.animations;

  // Built per turn (not memoised): reloadRuntimePolicy mutates the refs in
  // place, so a memo here would keep serving stale rules/hooks after /trust.
  const buildToolPolicy = useCallback(() => ({
    permissionRules: rulesRef.current,
    hooks: hooksRef.current,
    guardUnreadEdits: settings.guardUnreadEdits !== false,
    spillToolResults: settings.spillToolResults !== false,
    verifyPostconditions: true,
    journal: true,
    cwd: process.cwd(),
  }), [settings.guardUnreadEdits, settings.spillToolResults]);

  /**
   * Re-read project policy from disk. Runs at startup and after `/trust`, so a
   * freshly trusted repository starts using its own rules without a restart.
   */
  const reloadRuntimePolicy = useCallback(async (activeSessionId?: string) => {
    const cwd = process.cwd();
    const trusted = isProjectTrusted(cwd);
    // Plugin-provided hooks/commands are additive; project and user sources
    // keep their existing precedence. loadPlugins never throws.
    const plugins = await loadPlugins({ cwd, trusted });
    const loadedHooks = loadHooks({ cwd, trusted }, plugins.hooks);
    hooksRef.current = loadedHooks.hooks;

    const effective = loadEffectiveRules(cwd);
    rulesRef.current = mergeRuleSets(effective.rules);

    const commands = loadCustomCommands({ cwd, trusted }, plugins.commands);
    setCustomCommands(commands.commands);

    for (const warning of [...loadedHooks.errors, ...commands.errors, ...plugins.errors]) {
      logger.warn('Runtime policy warning', { warning });
    }
    if (effective.projectError) logger.debug('Project permission rules not loaded', { reason: effective.projectError });

    if (historyNavigatorRef.current === null) {
      historyNavigatorRef.current = new HistoryNavigator(loadHistory());
    }

    if (loadedHooks.hooks.length > 0) {
      const outcome = await runHooks({
        event: 'SessionStart',
        hooks: loadedHooks.hooks,
        cwd,
        payload: { event: 'SessionStart', cwd, sessionId: activeSessionId },
      });
      if (outcome.context) setHelpMessage(`[hook] ${outcome.context}`);
      for (const error of outcome.errors) logger.warn('SessionStart hook warning', { error });
    }
  }, []);

  const printedThreadErrorIdsRef = useRef<Set<string>>(new Set());
  // Dedupe the baked error card so a theme change cannot reprint the same error.
  const printedErrorRef = useRef<string | null>(null);

  const initializeWithConfig = useCallback(async (loadedConfig: Config) => {
    // The first-run wizard may have just written a new config, so refresh the
    // provider registry before building the client.
    await loadRuntimeConfig(true);
    setConfig(loadedConfig);

    clientRef.current = buildClient(loadedConfig);

    // Warm the model list in the background so the first /model open is instant
    // even on a slow provider.
    try {
      prefetchProviderModels(clientRef.current, loadedConfig.provider, {
        baseURL: getProvider(loadedConfig.provider)?.baseURL,
      });
    } catch {
      // A missing key is reported by the client itself; warmup is optional.
    }

    // Other providers warm up a moment later, so switching providers is just
    // as fast without delaying startup or spending data during the first turn.
    const warmup = setTimeout(() => {
      for (const provider of getAllProviders()) {
        if (provider.id === loadedConfig.provider) continue;
        if (resolveApiKey({ provider: provider.id }) === null) continue;
        try {
          prefetchProviderModels(
            buildClient({ provider: provider.id, model: provider.models[0]?.id ?? '' }),
            provider.id,
            { baseURL: provider.baseURL },
          );
        } catch {
          // Unusable provider (bad config); skip it.
        }
      }
    }, 2_000);
    warmup.unref?.();

    // Initialize MCP servers
    await initializeMcp();

    // Load project policy (hooks, permission rules, custom commands) and fire
    // the SessionStart hook. A warning here must never block startup.
    await reloadRuntimePolicy(sessionId).catch((err) => {
      logger.warn('Could not load runtime policy', { error: String(err) });
    });

    // Load or create session
    let loadedSession: Session | null = null;
    if (sessionId) {
      loadedSession = await loadSession(sessionId);
      if (loadedSession) {
        const systemPrompt = await generateSystemPrompt();
        loadedSession.completionMessages = ensureSystemPromptAtTop(
          loadedSession.completionMessages,
          systemPrompt
        );
        const savedVariant = loadedSession.variant;
        const restoredVariant =
          savedVariant && VARIANTS.some((item) => item.id === savedVariant)
            ? savedVariant
            : undefined;
        if (restoredVariant) setVariantId(restoredVariant);
        loadedSession.variant = restoredVariant;

        // The active provider/model is global; a resumed session does not
        // override it. Its saved pair remains historical metadata only.
        loadedSession.provider = loadedConfig.provider;
        loadedSession.model = loadedConfig.model;

        setTodosForSession(loadedSession.id, loadedSession.todos);
        setSession(loadedSession);
        setCompletionMessages(loadedSession.completionMessages);
        const savedActivities = loadedSession.subAgentActivities ?? [];
        setSubAgentActivities(savedActivities);
        setShowSubAgentPanel(false);
        if (!didPrintIntroRef.current) {
          if (hasConversationMessages(loadedSession.completionMessages)) {
            setMeasuringTranscript(true);
          }
          replayMessagesToScrollback(addStatic, loadedSession.completionMessages, theme, MAX_REPLAY_MESSAGES, columns);
          replaySubAgentActivities(addStatic, savedActivities, theme);
          didPrintIntroRef.current = true;
          sessionSavedRef.current = true;
        }
      } else {
        setError(`Session "${sessionId}" not found. Starting a new session.`);
      }
    }

    if (!loadedSession) {
      // Initialize fresh conversation
      const initialCompletionMessages = await initializeMessages();
      setCompletionMessages(initialCompletionMessages);

      const newSession = createSession(loadedConfig.model, loadedConfig.provider);
      clearTodos(newSession.id);
      newSession.completionMessages = initialCompletionMessages;
      // Register the session immediately so it is listed by /session and can be
      // resumed even if this process dies before the first turn finishes.
      await saveSession(newSession).catch((err) => {
        logger.warn('Could not register new session', { error: String(err) });
      });
      setSession(newSession);
      didPrintIntroRef.current = true;
    }

    setInitialized(true);
  }, [dangerouslySkipPermissions, sessionId, addStatic, columns, theme]);

  useEffect(() => {
    if (!loading || !animationsEnabled) {
      setSpinnerFrame(0);
      return;
    }

    // Termux/Android renders slower; fewer frames means less CPU/battery.
    const spinnerIntervalMs = process.platform === 'android' ? 120 : 60;
    const interval = setInterval(() => {
      setSpinnerFrame((prev) => prev + 1);
    }, spinnerIntervalMs);

    return () => clearInterval(interval);
  }, [loading, animationsEnabled]);

  // Decode rate: fed by growth of the streaming buffer. The tracker ignores
  // the first fraction of a second so the UI does not flash a bogus rate.
  useEffect(() => {
    const state = decodeRef.current;
    if (!isStreaming) {
      state.tracker.reset();
      state.length = 0;
      if (state.shown !== null) {
        state.shown = null;
        setDecodeTps(null);
      }
      return;
    }

    const length = streamingText.length;
    if (length <= state.length) return;
    const delta = streamingText.slice(state.length);
    state.length = length;
    const sample = state.tracker.add(delta);
    if (sample.display && sample.display !== state.shown) {
      state.shown = sample.display;
      setDecodeTps(sample.display);
    }
  }, [streamingText, isStreaming]);

  // Live thinking clock. One tick per second is enough and stays cheap on
  // Android; the archived record gets the exact elapsed value.
  useEffect(() => {
    if (thinkingStartedAt === null) {
      setThinkingElapsedMs(0);
      return;
    }
    setThinkingElapsedMs(Date.now() - thinkingStartedAt);
    const interval = setInterval(() => {
      setThinkingElapsedMs(Date.now() - thinkingStartedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [thinkingStartedAt]);

  // Auto-expand while a reasoning phase is live, then fold back to a plain
  // one-line "Thought" header when it ends. A manual toggle (ctrl+t or a
  // click) wins until the next reasoning phase starts, so the panel never
  // reopens under the user's cursor.
  const reasoningActive = thinkingStartedAt !== null;
  const wasReasoningActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = wasReasoningActiveRef.current;
    wasReasoningActiveRef.current = reasoningActive;
    setThinkingExpanded((expanded) => {
      const next = nextThinkingExpansion({
        active: reasoningActive,
        wasActive,
        pinned: thinkingPinnedRef.current,
        expanded,
      });
      thinkingPinnedRef.current = next.pinned;
      return next.expanded;
    });
  }, [reasoningActive]);

  useEffect(() => {
    modelSearchRef.current = modelSearch;
  }, [modelSearch]);

  useEffect(() => {
    remoteModelsRef.current = remoteModels;
  }, [remoteModels]);

  // A delete confirmation belongs to the session picker only. Clear it as soon
  // as any other picker (or no picker) is shown so y/n cannot leak into the
  // model search box or the prompt.
  useEffect(() => {
    if (picker !== 'session') setPendingSessionDelete(null);
  }, [picker]);

  useEffect(() => {
    if (!error || printedErrorRef.current === error) return;
    printedErrorRef.current = error;
    addStatic(
      <Box paddingX={2}>
        <Text color={theme.error}>Error: {error}</Text>
      </Box>
    );
  }, [error, addStatic, theme]);

  useEffect(() => {
    for (const threadError of threadErrors) {
      if (threadError.transient || printedThreadErrorIdsRef.current.has(threadError.id)) {
        continue;
      }
      printedThreadErrorIdsRef.current.add(threadError.id);
      addStatic(
        <Box paddingX={2}>
          <Text color={theme.error}>Error: {threadError.message}</Text>
        </Box>
      );
    }
  }, [threadErrors, addStatic, theme]);

  // Mirror the session todo list into the live task panel after every tool
  // result, so todo_write checkmarks appear as soon as the agent calls it.
  useEffect(() => {
    const id = session?.id;
    if (!id) {
      setTodos([]);
      return;
    }
    setTodos(getTodosForSession(id));
  }, [session?.id, completionMessages]);

  // The cleanup runs on unmount; keep the latest palette in a ref so the
  // terminal-restore effect is not re-registered on every theme change.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // The alternate screen is entered and cleared by cli.tsx *before* Ink's
  // first render. Doing the raw \x1b[2J\x1b[H here (after commit) desyncs
  // Ink's incremental cursor/line accounting: Ink assumes the cursor is at the
  // bottom of the last frame, but the raw clear homes it to row 0, so later
  // diffs paint rows at the wrong offsets (e.g. a duplicated composer row).
  useEffect(() => {
    if (!stdout) return;
    return () => {
      stdout.write('\x1b[?1006l\x1b[?1000l');
      stdout.write('\x1b[?1049l');
      // After an update, tell the user to relaunch before the usual resume card:
      // the just-installed version is not what this process is running.
      const updateExit = exitUpdateRef.current;
      if (updateExit) stdout.write(`${formatUpdateExit(updateExit, themeRef.current)}\n`);
      // The card is painted while the themed terminal background is still set;
      // reset it afterwards so the user's own colours come back.
      const exitId = exitSessionIdRef.current;
      if (exitId) stdout.write(`${formatSessionExit(exitId, themeRef.current)}\n`);
      stdout.write('\x1b]111\x07');
    };
  }, [stdout]);

  // Mouse reporting stays on for wheel scrolling and thinking-block clicks.
  // PromptInput strips mouse reports before inserting text.
  const mouseTrackingEnabled = settings.mouseClicks && keyPrompt === null;
  useEffect(() => {
    if (!stdout) return;
    if (!mouseTrackingEnabled) {
      stdout.write('\x1b[?1006l\x1b[?1000l');
      return;
    }
    stdout.write('\x1b[?1000h\x1b[?1006h');
    return () => {
      stdout.write('\x1b[?1006l\x1b[?1000l');
    };
  }, [stdout, mouseTrackingEnabled]);

  // Re-render at the new size when the terminal is resized. Guard the values
  // so a transient 0/NaN during a zoom burst cannot poison the whole frame.
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      const next = {
        columns: finiteDim(stdout.columns, dims.columns),
        rows: finiteDim(stdout.rows, dims.rows),
      };
      // Skip no-op bursts (several resize events can fire for one zoom step).
      setDims((prev) =>
        prev.columns === next.columns && prev.rows === next.rows ? prev : next
      );
      // Force a viewport re-measure on every resize event, including the ones
      // the dims guard above ignored, so zoom cannot leave stale geometry.
      setResizeTick((tick) => tick + 1);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, dims.columns, dims.rows]);

  // One-time initialization: logging, approval handlers, config loading
  useEffect(() => {
    const init = async () => {
      // Set log level and initialize log file
      if (logLevel) {
        const level = LogLevel[logLevel.toUpperCase() as keyof typeof LogLevel];
        if (level !== undefined) {
          setLogLevel(level);
          initLogFile();

          logger.info(`Bitacode started with log level: ${logLevel}`);
          logger.info(`Log file: ${logger.getLogFilePath()}`);
        }
      }

      // Set global approval mode. Apply the persisted setting on startup; the
      // backend ORs the CLI skip flag, so a persisted 'manual' cannot cancel
      // --dangerously-skip-permissions.
      if (dangerouslySkipPermissions) {
        setDangerouslySkipPermissions(true);
      }
      setApprovalMode(settings.approvalMode);

      // Register interactive approval handler. In plan mode mutating requests
      // are rejected outright, so the tool never touches the file system.
      setApprovalHandler(async (req: ApprovalRequest): Promise<ApprovalResponse> => {
        if (modeRef.current === 'plan') return 'reject';
        return openApproval(req);
      });

      // The agent can pause to ask the user a question; the UI owns the
      // interaction and resolves the promise with the collected answers.
      // `askUser` does not forward a signal today, but the optional parameter
      // keeps the bridge ready: an abort settles and clears the slot.
      setAskHandler(async (req: AskRequest, _signal?: AbortSignal): Promise<AskResponse> => {
        return openAsk(req, _signal).catch(() => [] as AskResponse);
      });

      // Structured forms reuse the same dialog. Mapping stays in this adapter
      // so the tool itself has no React dependency.
      setFormHandler(async (req: FormRequest, signal?: AbortSignal): Promise<FormResponse> => {
        const askRequest: AskRequest = {
          sessionId: req.sessionId,
          questions: req.questions.map((question) => {
            // AskPrompt starts with the first option selected, so a form default
            // must mark its option recommended AND move it to the front.
            const preferredFirst = (options: AskOption[]): AskOption[] => {
              const index = options.findIndex((option) => option.recommended);
              return index > 0 ? [options[index]!, ...options.filter((_, i) => i !== index)] : options;
            };
            const options: AskOption[] | undefined =
              question.type === 'select'
                ? preferredFirst((question.options ?? []).map((label) => ({
                    label,
                    recommended: typeof question.default === 'string' && label === question.default,
                  })))
                : question.type === 'confirm'
                  ? preferredFirst([
                      { label: 'Yes', recommended: question.default === true },
                      { label: 'No', recommended: question.default === false },
                    ])
                  : undefined;
            return {
              id: question.id,
              question: `${question.label}${question.required ? ' *' : ''}`,
              context: req.title ? `${req.title} · ${question.type}` : question.type,
              options,
              allow_free_text: question.type !== 'select',
            };
          }),
        };
        // openAsk rejects on abort/duplicate; `form()` turns those into clear
        // cancellation/error messages instead of hanging forever.
        const answers = await openAsk(askRequest, signal);
        return req.questions.map((question, index): { id: string; value: string | boolean } => {
          const raw = answers[index]?.answer ?? '';
          if (question.type === 'confirm') {
            return { id: question.id, value: /^(y|yes|true|1)$/i.test(raw.trim()) };
          }
          return { id: question.id, value: raw };
        });
      });

      // Tool groups are opt-in; an empty setting keeps every schema visible.
      setToolGroups(settings.toolGroups as Parameters<typeof setToolGroups>[0]);

      // First run: create the shared config folder, then let the inline setup
      // flow choose a provider/model instead of failing with "no config".
      try {
        ensureUserConfigDirectory();
      } catch (err: any) {
        logger.warn('Could not create the Bitacode config directory', { error: err.message });
      }

      let loadedConfig = readConfig('active');
      if (!loadedConfig) {
        const detected = detectConfigFromEnvironment();
        if (detected) {
          try {
            writeConfig(detected, 'user');
          } catch (err: any) {
            logger.warn('Could not persist environment-detected config', { error: err.message });
          }
          loadedConfig = detected;
        }
      }
      if (!loadedConfig) {
        setInitialized(true);
        return;
      }

      await initializeWithConfig(loadedConfig);
    };

    init().catch((err) => {
      setError(`Initialization failed: ${err.message}`);
    });

    // Cleanup on unmount
    return () => {
      clearApprovalHandler();
      clearFormHandler();
      closeMcp();
      // Detached children would otherwise keep running after quit.
      stopAllProcesses();
      stopAllBackgroundJobs();
    };
  }, [openApproval, openAsk]);

  // Palette contents. Kept ahead of handleSubmit because Enter runs the highlighted row.
  // Command palette: prefix match on the name wins, keywords and the
  // description keep a search like "/key" finding "/provider".
  const commandQuery = inputText.trim().toLowerCase();
  const commandNeedle = commandQuery.replace(/^\//, '');
  const commandMatches = fuzzyFilter(SLASH_COMMANDS, commandNeedle, {
    getText: (cmd) => cmd.name,
    getAlias: (cmd) => `${cmd.description} ${cmd.keywords ?? ''}`,
  });
  const commandMeta = (name: string): string | undefined => {
    switch (name) {
      case '/model': return config?.model;
      case '/theme': return settings.theme;
      case '/provider': return config?.provider;
      case '/variant': return variantId;
      case '/verify': return 'checks';
      default: return undefined;
    }
  };
  const commandItems: PaletteItem[] = commandMatches.map(({ item: cmd, indices }) => ({
    id: cmd.name,
    label: cmd.name,
    description: cmd.description,
    section: cmd.category,
    meta: commandMeta(cmd.name),
    matchIndices: indices,
  }));
  const commandItemsRef = useRef(commandItems);
  commandItemsRef.current = commandItems;

  const providerItems = getAllProviders().map((provider) => {
    const keyReady = resolveApiKey({ provider: provider.id }) !== null;
    const modelCount = remoteModels[provider.id]?.length || provider.models.length;
    return {
      id: provider.id,
      label: provider.name,
      description: `${provider.id}${keyReady ? '' : ' · key needed'}`,
      meta: `${modelCount} model${modelCount === 1 ? '' : 's'}`,
      active: config?.provider === provider.id,
    };
  });
  const modelProviderId = pendingProviderId ?? config?.provider;
  const modelProvider = modelProviderId ? getProvider(modelProviderId) : undefined;
  const staticModelItems: PaletteItem[] = (modelProvider?.models ?? []).map((model) => ({
    id: model.id,
    label: model.name,
    description: formatContextWindow(model.contextWindow),
    contextWindow: model.contextWindow,
  }));
  const cachedModelItems = modelProviderId ? remoteModels[modelProviderId] : undefined;
  const allModelItems: PaletteItem[] =
    cachedModelItems && cachedModelItems.length > 0 ? cachedModelItems : staticModelItems;
  const modelSearchTerm = modelSearch.trim().toLowerCase();
  const modelItems: PaletteItem[] = (modelSearchTerm
    ? allModelItems.filter(
        (item) =>
          item.label.toLowerCase().includes(modelSearchTerm) ||
          item.id.toLowerCase().includes(modelSearchTerm)
      )
    : allModelItems
  ).map((item) => ({
    ...item,
    // Right-align the context window so names form a clean column, and mark the
    // model that is currently active (only when browsing its own provider).
    description: undefined,
    meta: item.description,
    active: Boolean(
      config &&
      !pendingProviderId &&
      config.provider === modelProviderId &&
      config.model === item.id,
    ),
  }));
  const selectedModelIndex = clampIndex(pickerIndex, modelItems.length);

  const variantItems = VARIANTS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    color: variant.color,
    bold: true,
  }));

  // The CLI skip flag forces yolo at runtime; show it that way everywhere.
  const effectiveApprovalMode: ApprovalMode = dangerouslySkipPermissions
    ? 'yolo'
    : settings.approvalMode;

  // The display order must stay index-aligned with SETTING_KEYS, because
  // toggleSetting() indexes that table by the highlighted row.
  const settingItems: DialogItem[] = [
    {
      id: 'animations',
      label: 'Animations',
      section: 'Interface',
      meta: settings.animations ? 'on' : 'off',
    },
    {
      id: 'mouseClicks',
      label: 'Mouse click thinking',
      meta: settings.mouseClicks ? 'on' : 'off',
    },
    {
      id: 'approvalMode',
      label: 'Approval mode',
      section: 'Agent',
      meta: effectiveApprovalMode,
    },
    {
      id: 'theme',
      label: 'Theme',
      section: 'Appearance',
      meta: settings.theme ?? 'black',
    },
    {
      id: 'statusLine',
      label: 'Status line',
      meta: `${(settings.statusLine ?? STATUS_LINE_ITEMS).length}/${STATUS_LINE_ITEMS.length}`,
    },
  ];

  // Each row carries a live swatch painted with that palette's own colours;
  // DialogList renders it as an accent glyph on the palette background.
  const themeItems: DialogItem[] = THEME_NAMES.map((name) => {
    // getTheme resolves a registered custom palette, so its swatch shows the
    // real colours instead of the placeholder stored in `themes.custom`.
    const palette = getTheme(name);
    return {
      id: name,
      label: name,
      swatch: { accent: palette.accent, bg: palette.bg },
      description: THEME_INTENTS[name],
      meta: (settings.theme ?? 'black') === name ? 'current' : undefined,
    };
  });

  const toggleSetting = useCallback(
    (index: number) => {
      const key = SETTING_KEYS[index];
      if (!key) return;
      if (key === 'approvalMode') {
        const current = APPROVAL_MODES.indexOf(settings.approvalMode);
        const nextMode = APPROVAL_MODES[(current + 1) % APPROVAL_MODES.length]!;
        const next = { ...settings, approvalMode: nextMode };
        setSettings(next);
        saveSettings(next);
        setApprovalMode(nextMode);
        return;
      }
      if (key === 'theme') {
        setSettingsIndex(null);
        setPicker('theme');
        setPickerIndex(Math.max(0, THEME_NAMES.indexOf(settings.theme ?? 'black')));
        return;
      }
      if (key === 'statusLine') {
        // Segment toggling happens in a dedicated palette row-by-row picker.
        setSettingsIndex(null);
        setPicker('statusLine');
        setPickerIndex(0);
        return;
      }
      const next = { ...settings, [key]: !settings[key] };
      setSettings(next);
      saveSettings(next);
    },
    [settings, setSettings]
  );

  const statusLineItems: DialogItem[] = STATUS_LINE_ITEMS.map((id) => ({
    id,
    label: id,
    section: 'Segments',
    meta: (settings.statusLine ?? STATUS_LINE_ITEMS).includes(id) ? 'shown' : 'hidden',
  }));

  const persistActiveSelection = useCallback(
    (
      providerId: string,
      modelId: string,
      modelInfo?: { name?: string; contextWindow?: number }
    ) => {
      try {
        const target =
          getActiveRuntimeConfigPath() === getRuntimeConfigPath('project') ? 'project' : 'user';
        writeActiveSelection(providerId, modelId, target, process.cwd(), modelInfo);
      } catch (err: any) {
        setError(`Selection applies to this session but could not be saved: ${err.message}`);
      }
    },
    []
  );

  // Picker/key-prompt path when there is no config yet: persist the selection
  // and boot the client immediately, so setup never needs the wizard.
  const finalizeFirstConfig = useCallback(
    (providerId: string, modelId: string, modelInfo?: { name?: string; contextWindow?: number }) => {
      persistActiveSelection(providerId, modelId, modelInfo);
      setError(null);
      void initializeWithConfig({ provider: providerId, model: modelId }).catch((err: any) => {
        setError(`Initialization failed: ${err.message}`);
      });
    },
    [initializeWithConfig, persistActiveSelection]
  );

  const getModelPaletteInfo = useCallback((providerId: string, modelId: string) => {
    const remote = remoteModelsRef.current[providerId]?.find((item) => item.id === modelId);
    if (remote) return { name: remote.label, contextWindow: remote.contextWindow };
    const cachedWindow = getCachedContextWindow(providerId, modelId);
    if (cachedWindow) return { name: modelId, contextWindow: cachedWindow };
    const details = getModelDetails(providerId, modelId);
    return details ? { name: details.name, contextWindow: details.contextWindow } : undefined;
  }, []);

  const loadModels = useCallback(
    async (providerId: string, client: OpenAI, preferredModelId?: string) => {
      const cached = remoteModelsRef.current[providerId];
      if (cached?.length) {
        if (!modelSearchRef.current && preferredModelId) {
          const index = cached.findIndex((item) => item.id === preferredModelId);
          if (index >= 0) setPickerIndex(index);
        }
        return;
      }

      const seq = ++modelFetchSeqRef.current;
      setModelsLoading(true);
      setModelNotice(null);

      // Cache-first inside: a warm list resolves without a network round trip.
      const result = await listProviderModels(client, providerId, {
        baseURL: getProvider(providerId)?.baseURL,
      });
      if (seq !== modelFetchSeqRef.current) return;

      setModelsLoading(false);
      if (result.items.length > 0) {
        modelCacheTimeRef.current[providerId] = Date.now();
        setRemoteModels((prev) => ({ ...prev, [providerId]: result.items }));
        // Don't yank the highlight away while the user is typing a search.
        if (!modelSearchRef.current) {
          const index = preferredModelId
            ? result.items.findIndex((item) => item.id === preferredModelId)
            : 0;
          setPickerIndex(index >= 0 ? index : 0);
        }
      }

      const staticCount = getProvider(providerId)?.models.length ?? 0;
      if (result.error) {
        setModelNotice(
          staticCount > 0
            ? `Could not fetch models (${result.error}); using built-in list.`
            : `Could not fetch models: ${result.error}`
        );
      } else if (result.items.length === 0) {
        setModelNotice(
          staticCount > 0
            ? 'The provider returned no models; using built-in list.'
            : 'The provider returned no models.'
        );
      }
    },
    []
  );

  const beginProviderSwitch = useCallback(
    (providerId: string) => {
      const provider = getProvider(providerId);
      if (!provider) return;

      setPendingProviderId(providerId);
      setPicker('model');
      setPickerIndex(0);
      setModelNotice(null);
      setModelSearch('');

      try {
        const client = buildClient({
          provider: providerId,
          model: provider.models[0]?.id ?? '',
        });
        void loadModels(providerId, client);
      } catch (err: any) {
        setError(`Cannot switch to ${provider.name}: ${err.message}`);
        setPendingProviderId(null);
        setPicker(null);
        setModelsLoading(false);
      }
    },
    [loadModels]
  );

  const handleApiKeySubmit = useCallback(
    async (value: string) => {
      const prompt = keyPrompt;
      if (!prompt || prompt.busy) return;

      const apiKey = value.trim();
      if (!apiKey) {
        setKeyPrompt({ ...prompt, error: 'API key cannot be empty.' });
        return;
      }

      setKeyPrompt({ ...prompt, busy: true, error: null });

      let client: OpenAI;
      try {
        client = buildClient({ provider: prompt.providerId, model: '' }, apiKey);
      } catch (err: any) {
        setKeyPrompt({ ...prompt, busy: false, error: err.message });
        return;
      }

      // Check the key before persisting it so a typo is not saved. A network
      // throw must clear `busy` or the dialog would hang on a spinner.
      let result: Awaited<ReturnType<typeof listProviderModels>>;
      try {
        result = await listProviderModels(client, prompt.providerId);
      } catch (err: any) {
        setKeyPrompt({
          ...prompt,
          busy: false,
          error: `Could not verify the API key: ${err?.message ?? String(err)}`,
        });
        return;
      }
      if (result.authError) {
        setKeyPrompt({
          ...prompt,
          busy: false,
          error: result.error ?? 'The provider rejected that API key.',
        });
        return;
      }

      const provider = getProvider(prompt.providerId);
      if (result.items.length === 0 && (provider?.models.length ?? 0) === 0) {
        setKeyPrompt({
          ...prompt,
          busy: false,
          error: result.error
            ? `Could not load models: ${result.error}`
            : 'No models available for this provider.',
        });
        return;
      }

      try {
        const target = prompt.path === getRuntimeConfigPath('user') ? 'user' : 'project';
        writeProviderApiKey(prompt.providerId, apiKey, target);
        await loadRuntimeConfig(true);
      } catch (err: any) {
        setKeyPrompt({
          ...prompt,
          busy: false,
          error: `Could not save API key: ${err.message}`,
        });
        return;
      }

      if (result.items.length > 0) {
        setRemoteModels((prev) => ({ ...prev, [prompt.providerId]: result.items }));
      }

      // A saved key is a usable config on its own, so the provider and its
      // default model are selected right here. Writing only the key is what
      // used to leave the old provider selected and force a manual re-pick.
      const providerModels = getProvider(prompt.providerId)?.models ?? [];
      const firstModel =
        providerModels[0]?.id
        ?? result.items[0]?.id
        ?? (prompt.providerId === config?.provider ? config.model : undefined);
      const modelInfo = {
        name: result.items[0]?.label ?? providerModels[0]?.name,
        contextWindow: result.items[0]?.contextWindow ?? providerModels[0]?.contextWindow,
      };

      setKeyPrompt(null);
      if (!firstModel) {
        // Key saved, but the provider exposes no model: keep the provider
        // selected so the picker can fill the model in.
        persistActiveSelection(prompt.providerId, config?.model ?? '');
        setError('API key saved, but this provider returned no models to select.');
        return;
      }

      if (!config) {
        finalizeFirstConfig(prompt.providerId, firstModel, modelInfo);
        return;
      }

      if (prompt.providerId === config.provider && firstModel === config.model) {
        return;
      }

      // Persist before opening the picker: cancelling the picker must not undo
      // the selection the key just enabled.
      persistActiveSelection(prompt.providerId, firstModel, modelInfo);
      finalizeFirstConfig(prompt.providerId, firstModel, modelInfo);
    },
    [config, keyPrompt, finalizeFirstConfig, persistActiveSelection]
  );

  // Clear per-turn UI state without touching the saved session or transcript.
  const resetLiveState = useCallback(() => {
    setError(null);
    setHelpMessage(null);
    setThinkingText('');
    setThinkingElapsedMs(0);
    setThinkingStartedAt(null);
    setThinkingArchived(false);
    reasoningRef.current = '';
    thinkingPinnedRef.current = false;
    setThinkingExpanded(false);
    setStreamingText('');
    setIsStreaming(false);
    setLoading(false);
    setActiveTool(null);
    setSubAgentActivities([]);
    setShowSubAgentPanel(false);
    setThreadErrors([]);
    setLastUsage(null);
    setTotalCost(0);
    setInputText('');
    setSearchQuery(null);
    setInputResetKey((prev) => prev + 1);
    setPicker(null);
    setSettingsIndex(null);
    setPendingProviderId(null);
    setModelSearch('');
    setModelNotice(null);
    setModelsLoading(false);
    setKeyPrompt(null);
    // Close any modal promise before dropping it: otherwise the tool's await
    // hangs forever after a /new or /session switch.
    settleApproval('reject');
    settleAsk([]);
    printedErrorRef.current = null;
    setShowShortcuts(false);
    setShowErrorPanel(false);
    commandIndexRef.current = 0;
    setCommandIndex(0);
    setSessionItems([]);
    setSessionsLoading(false);
    assistantMessageRef.current = null;
    streamingBufferRef.current = {
      unflushedContent: '',
      hasFlushedAnyLine: false,
      lastUiUpdate: 0,
    };
    blockedToolIdsRef.current.clear();
    pendingImageRef.current = null;
    sessionSavedRef.current = false;
  }, [settleApproval, settleAsk]);

  const startNewSession = useCallback(async (): Promise<boolean> => {
    if (!config) {
      setError('Cannot start a new session: no provider/model is configured.');
      return false;
    }

    setError(null);
    setHelpMessage(null);

    // Stop any in-flight turn first. Without this the old run keeps emitting
    // events and its `finally` block pushes the previous conversation back into
    // the freshly created session, so /new looked like it "did nothing" or
    // duplicated the old transcript.
    const previousSessionId = session?.id ?? null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeRunRef.current += 1;
    // Queued prompts belong to the old turn/session; never deliver them into
    // the fresh one.
    deliveryInFlightRef.current = false;
    queuedDeliveryRef.current = null;
    if (previousSessionId) inboxRef.current.clear(previousSessionId);

    try {
      // Preserve the current conversation before wiping the screen. If this
      // fails, keep the existing session so no transcript is lost.
      if (session && hasConversationMessages(completionMessages)) {
        const finished: Session = {
          ...session,
          completionMessages,
          todos: getTodosForSession(session.id),
          title: generateTitle(completionMessages),
          variant: variantId,
          subAgentActivities,
        };
        await saveSession(finished);
      }

      // Build the fresh transcript before touching visible state.
      const initialMessages = await initializeMessages();
      const nextSession = createSession(config.model, config.provider);
      nextSession.variant = variantId;
      clearTodos(nextSession.id);
      nextSession.completionMessages = initialMessages;
      await saveSession(nextSession).catch((err) => {
        logger.warn('Could not register new session', { error: String(err) });
      });

      setCompletionMessages(initialMessages);
      setSession(nextSession);
      setTodos([]);
      resetLiveState();
      // Stale error ids from the old session must not suppress new ones.
      printedThreadErrorIdsRef.current = new Set();
      if (previousSessionId) clearTodos(previousSessionId);

      // Fresh canvas for the new session. Clearing the transcript state is
      // enough: Ink's incremental renderer repaints only the changed rows.
      // A raw \x1b[2J\x1b[H here would desync its cursor tracking and flicker.
      setStaticItems([]);
      setUserScroll(0);
      setMeasuringTranscript(false);
      return true;
    } catch (err: any) {
      setError(`Failed to start a new session: ${err.message}`);
      return false;
    }
  }, [
    config,
    session,
    completionMessages,
    variantId,
    resetLiveState,
    stdout,
  ]);

  const openSessionPicker = useCallback(async () => {
    setPendingSessionDelete(null);
    setSessionsLoading(true);
    setSessionItems([]);
    try {
      const summaries = await listSessions();
      const items = summaries.slice(0, 100).map((summary) => {
        const title =
          summary.title.length > 56 ? `${summary.title.slice(0, 53)}...` : summary.title;
        const model = summary.model ? summary.model.split('/').pop()! : '';
        const modelLabel = [summary.provider, model].filter(Boolean).join(' / ');
        const current = summary.id === session?.id ? ' · current' : '';
        const age = formatSessionAge(summary.updatedAt || summary.createdAt);
        const count = summary.messageCount;
        return {
          id: summary.id,
          label: title || 'Untitled session',
          // Order: when · which model · how much · whether it is open now.
          description: `${age} · ${modelLabel || 'unknown model'} · ${count} msg${count === 1 ? '' : 's'}${current}`,
        };
      });
      setSessionItems(items);
      const currentIndex = items.findIndex((item) => item.id === session?.id);
      setPickerIndex(currentIndex >= 0 ? currentIndex : 0);
      setPicker('session');
    } catch (err: any) {
      setError(`Could not list sessions: ${err.message}`);
    } finally {
      setSessionsLoading(false);
    }
  }, [session?.id]);

  /** Open the list of saved child transcripts for the active session. */
  const openSubagents = useCallback(async () => {
    setHelpMessage(null);
    setSettingsIndex(null);
    setSubagentDetail(null);
    setSubagentLoading(true);
    setSubagentRuns([]);
    setPickerIndex(0);
    setPicker('subagents');
    try {
      const runs = await listSubAgentRuns(session?.id ?? '');
      setSubagentRuns(runs);
      setPickerIndex(0);
    } catch (err: any) {
      setError(`Could not list sub-agents: ${err?.message ?? String(err)}`);
    } finally {
      setSubagentLoading(false);
    }
  }, [session?.id]);

  /** Files in the current folder + fuzzy matches + installed skills for `@`. */
  const provideMentionCandidates = useCallback(
    // No UI-side trim: return every match the bounded file scan finds, then
    // skills. The popup windows through long lists and End jumps to skills.
    async (token: string) => collectMentionCandidates(process.cwd(), token, { limit: 600 }),
    []
  );

  const openSubagentDetail = useCallback(async (id: string) => {
    if (!session?.id) return;
    const record = await loadSubAgentRun(session.id, id);
    if (record) setSubagentDetail(record);
    else setError('That sub-agent transcript is no longer available.');
  }, [session?.id]);

  const deleteSavedSession = useCallback(
    async (id: string, refreshPicker = false) => {
      if (!id) return;
      setError(null);
      try {
        // Deleting the active session must first move to a fresh one; otherwise
        // the next save would immediately recreate the file we just removed.
        if (session?.id === id) {
          const started = await startNewSession();
          if (!started) return;
        }
        const removed = await deleteSession(id);
        clearTodos(id);
        if (!removed) {
          setError(`Could not delete session "${id}".`);
          return;
        }
        if (refreshPicker) await openSessionPicker();
      } catch (err: any) {
        setError(`Could not delete session: ${err.message}`);
      }
    },
    [session?.id, startNewSession, openSessionPicker]
  );

  const switchSession = useCallback(
    async (id: string) => {
      if (!config) {
        setError('Cannot open a session: no provider/model is configured.');
        return;
      }
      if (id === session?.id) {
        setPicker(null);
        return;
      }

      // Stop the old turn before installing another session: its `finally`
      // would otherwise save the previous transcript over the new one.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      activeRunRef.current += 1;
      deliveryInFlightRef.current = false;
      queuedDeliveryRef.current = null;
      if (session?.id) inboxRef.current.clear(session.id);

      try {
        const loaded = await loadSession(id);
        if (!loaded) {
          setError(`Session "${id}" was not found.`);
          return;
        }

        // Preserve the current conversation before replacing it.
        if (session && hasConversationMessages(completionMessages)) {
          const toSave: Session = {
            ...session,
            completionMessages,
            todos: getTodosForSession(session.id),
            title: generateTitle(completionMessages),
            variant: variantId,
            subAgentActivities,
          };
          await saveSession(toSave);
        }

        const systemPrompt = await generateSystemPrompt();
        const messages = ensureSystemPromptAtTop(loaded.completionMessages, systemPrompt);

        // The active provider/model is global and stays fixed when jumping
        // between sessions. A session's saved provider/model is history only.
        const savedVariant = loaded.variant;
        const nextVariant =
          savedVariant && VARIANTS.some((item) => item.id === savedVariant)
            ? savedVariant
            : variantId;

        loaded.provider = config.provider;
        loaded.model = config.model;
        loaded.variant = nextVariant;
        loaded.completionMessages = messages;

        setVariantId(nextVariant);
        if (settings.variant !== nextVariant) {
          const nextSettings = { ...settings, variant: nextVariant };
          setSettings(nextSettings);
          saveSettings(nextSettings);
        }

        setCompletionMessages(messages);
        setSession(loaded);
        setTodosForSession(loaded.id, loaded.todos);
        setTodos(loaded.todos);
        resetLiveState();
        const loadedActivities = loaded.subAgentActivities ?? [];
        setSubAgentActivities(loadedActivities);
        setShowSubAgentPanel(false);

        setStaticItems([]);
        setUserScroll(0);
        if (hasConversationMessages(messages)) {
          setMeasuringTranscript(true);
        }
        replayMessagesToScrollback(addStatic, messages, theme, MAX_REPLAY_MESSAGES, columns);
        replaySubAgentActivities(addStatic, loadedActivities, theme);
        didPrintIntroRef.current = true;
        sessionSavedRef.current = true;
      } catch (err: any) {
        setError(`Could not open session: ${err.message}`);
      }
    },
    [
      config,
      session,
      completionMessages,
      variantId,
      settings,
      addStatic,
      resetLiveState,
      stdout,
      theme,
    ]
  );

  /** Run `! <cmd>` directly through the bash tool, without involving the model. */
  const runShellCommand = useCallback(async (command: string) => {
    setError(null);
    showToast(`$ ${command}`, 0);
    try {
      const result = await handleToolCall(
        'bash',
        { command },
        { sessionId: session?.id, abortSignal: abortControllerRef.current?.signal }
      );
      addToolResultView(addStatic, 'bash', JSON.stringify({ command }), result, theme);
    } catch (err: any) {
      setError(`Shell command failed: ${err?.message ?? String(err)}`);
    }
  }, [session?.id, addStatic, showToast, theme]);

  /** Persist the live session, then exit with its resume id on screen. */
  const exitWithSave = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    if (!session) {
      exit();
      return;
    }
    const finished: Session = {
      ...session,
      completionMessages,
      todos: getTodosForSession(session.id),
      title: generateTitle(completionMessages),
      variant: variantId,
      subAgentActivities,
    };
    void saveSession(finished)
      .catch(() => undefined)
      .finally(() => {
        exitSessionIdRef.current = finished.id;
        sessionSavedRef.current = true;
        exit();
      });
  }, [session, completionMessages, variantId, subAgentActivities, exit]);

  /** Check npm, install the newest release, then close so it can take effect. */
  const handleUpdate = useCallback(async (local = false) => {
    if (updatingRef.current) {
      showToast('An update is already running…');
      return;
    }
    updatingRef.current = true;
    setError(null);
    let exiting = false;
    try {
      const scope: 'global' | 'local' = local ? 'local' : 'global';
      const info = await checkForUpdate(version ?? '', { force: true });
      if (!info) {
        setError('Could not check npm for updates. Check your connection and try again.');
        return;
      }
      if (!info.updateAvailable) {
        showToast(`Already up to date (v${info.current})`);
        return;
      }

      showToast(`Installing v${info.latest} (${scope})…`, 0);
      const result = await installUpdate({ version: info.latest, global: !local });
      if (!result.success) {
        setError(formatInstallFailure(info.latest, scope, result.message));
        return;
      }

      // npm has replaced the package on disk, but this process keeps running the
      // old code. Save the conversation, close the TUI, and print a card telling
      // the user to reopen for the new version.
      exitUpdateRef.current = { from: info.current, to: info.latest, scope };
      showToast(`Updated to v${info.latest} — closing…`, 0);
      exiting = true;
      setTimeout(() => exitWithSave(), 450);
    } finally {
      // Keep the guard closed once we are about to exit; otherwise let the user
      // retry after an early return or a failed install.
      if (!exiting) updatingRef.current = false;
    }
  }, [version, showToast, exitWithSave]);

  const handleSlashCommand = useCallback(async (cmd: string, raw = cmd): Promise<boolean> => {
    const parts = raw.trim().split(/\s+/);
    const command = cmd.toLowerCase();

    switch (command) {
      case '/quit':
      case '/exit':
        exitWithSave();
        return true;
      case '/subagents':
        void openSubagents();
        return true;
      case '/github':
      case '/bug': {
        const url = command === '/bug' ? BUG_REPORT_URL : REPO_URL;
        // Best-effort: never break the TUI if no browser can be launched.
        void openInBrowser(url)
          .then((message) => showToast(message))
          .catch((err: unknown) =>
            setError(`Could not open browser: ${err instanceof Error ? err.message : String(err)}`)
          );
        return true;
      }
      case '/review': {
        const target = parts.slice(1).join(' ').trim();
        const prompt = target
          ? `Use the sub_agent tool with agent_type="Review" to review: ${target}. Report findings with severity and file:line references.`
          : 'Use the sub_agent tool with agent_type="Review" to review the current uncommitted changes (git diff) and recent work in this repository. Report findings with severity and file:line references.';
        setHelpMessage(null);
        setInputText(prompt);
        setInputResetKey((prev) => prev + 1);
        showToast('Review delegation ready · press enter to run');
        return true;
      }
      case '/help':
        setHelpMessage(buildHelpText(effectiveApprovalMode));
        return true;
      case '/update':
        void handleUpdate(parts[1]?.toLowerCase() === '--local');
        return true;
      case '/new':
        void startNewSession();
        return true;
      case '/session':
        if (parts[1]?.toLowerCase() === 'delete') {
          if (parts[2]) {
            void deleteSavedSession(parts[2]);
          } else {
            setError('Usage: /session delete <id>');
          }
        } else if (parts[1]) {
          void switchSession(parts[1]);
        } else {
          void openSessionPicker();
        }
        return true;
      case '/model':
        if (!config && !pendingProviderId) {
          setPicker('provider');
          setPickerIndex(0);
          setModelNotice(null);
          setModelSearch('');
          return true;
        }
        setPendingProviderId(null);
        setModelNotice(null);
        setModelSearch('');
        setPicker('model');
        setPickerIndex(Math.max(0, allModelItems.findIndex((item) => item.id === config?.model)));
        if (config && clientRef.current) {
          void loadModels(config.provider, clientRef.current, config.model);
        }
        return true;
      case '/provider':
        setPendingProviderId(null);
        setModelNotice(null);
        setModelSearch('');
        setPicker('provider');
        setPickerIndex(Math.max(0, providerItems.findIndex((item) => item.id === config?.provider)));
        return true;
      case '/variant':
        setPicker('variant');
        setPickerIndex(Math.max(0, VARIANTS.findIndex((item) => item.id === variantId)));
        return true;
      case '/theme':
        setHelpMessage(null);
        setSettingsIndex(null);
        setPicker('theme');
        setPickerIndex(Math.max(0, THEME_NAMES.indexOf(settings.theme ?? 'black')));
        return true;
      case '/settings':
        setHelpMessage(null);
        setSettingsIndex(0);
        return true;
      case '/find': {
        const query = parts.slice(1).join(' ').trim();
        if (!query) {
          setError('Usage: /find <text>');
        } else {
          setHelpMessage(null);
          setSearchQuery(query);
          setUserScroll(0);
          showToast(`Search: ${query}`, 0);
        }
        return true;
      }
      case '/search': {
        const query = parts.slice(1).join(' ').trim();
        if (!query) {
          setError('Usage: /search <text>  (searches every saved session)');
          return true;
        }
        try {
          const result = await searchSessions(query);
          if (!result.ok) {
            setError(`Session search failed: ${result.error}`);
            return true;
          }
          if (result.value.length === 0) {
            showToast(`No sessions match "${query}"`, 0);
            return true;
          }
          const lines = result.value.map((hit, index) =>
            `${index + 1}. [${hit.sessionId}] ${hit.title} — ${hit.snippet}`
          );
          setHelpMessage(`Sessions matching "${query}"\n\n${lines.join('\n')}\n\nUse /session <id> to open one.`);
        } catch (error) {
          logger.warn('Session search crashed', { error: String(error) });
          setError('Session search failed unexpectedly. See the log for details.');
        }
        return true;
      }
      case '/agent': {
        const discovered = discoverAgents();
        if (!discovered.ok) {
          setError(`Agent discovery failed: ${discovered.error}`);
        } else {
          setHelpMessage(`Available agents\n\n${renderAgentCatalog(discovered.value)}\n\nUse \`agent_type: "<name>"\` with the sub_agent tool.`);
        }
        return true;
      }
      case '/stash': {
        const action = (parts[1] ?? 'list').toLowerCase();
        try {
          if (action === 'save') {
            const text = parts.slice(2).join(' ').trim() || inputText.trim();
            if (!text) {
              setError('Usage: /stash save <text>  (or type text and run /stash save)');
            } else {
              const result = saveDraft(text);
              if (!result.ok) setError(result.error);
              else showToast(`Saved draft ${result.value.id}`, 0);
            }
          } else if (action === 'pop') {
            const result = popDraft(parts[2] ?? 'latest');
            if (!result.ok) setError(result.error);
            else {
              setInputText(result.value.text);
              setInputResetKey((prev) => prev + 1);
              showToast(`Restored draft ${result.value.id}`, 0);
            }
          } else if (action === 'delete') {
            if (!parts[2]) {
              setError('Usage: /stash delete <id>');
              return true;
            }
            const result = deleteDraft(parts[2]);
            if (!result.ok) setError(result.error);
            else showToast(result.value ? `Deleted ${parts[2]}` : 'No such draft', 0);
          } else {
            const result = listDrafts();
            if (!result.ok) setError(result.error);
            else {
              const lines = result.value.map((draft) => `${draft.id}\t${draft.savedAt ? new Date(draft.savedAt).toISOString() : ''}\t${draft.label || draft.text.slice(0, 60)}`);
              setHelpMessage(lines.length ? `Saved drafts\n\n${lines.join('\n')}\n\n/stash pop [id]` : 'No saved drafts.');
            }
          }
        } catch (error) {
          logger.warn('Draft stash command failed', { error: String(error) });
          setError('Draft stash failed. See the log for details.');
        }
        return true;
      }
      case '/image': {
        const imagePath = parts.slice(1).join(' ').trim();
        if (!imagePath) {
          setError('Usage: /image <path>');
          return true;
        }
        setError(null);
        try {
          const result = await handleToolCall(
            'read_image',
            { file_path: imagePath },
            { sessionId: session?.id }
          );
          if (/^Error\b/i.test(result.trim())) {
            addStatic(
              <Box paddingX={2} marginBottom={1}>
                <Text color={theme.error}>{`Image error: ${result.trim()}`}</Text>
              </Box>
            );
          } else {
            const dataUrl = result.match(/data:[^\s]+/)?.[0] ?? '';
            pendingImageRef.current = { path: imagePath, dataUrl };
            addStatic(
              <Box paddingX={2} marginBottom={1}>
                <Text color={theme.success}>{`Image attached: ${imagePath}`}</Text>
              </Box>
            );
          }
        } catch (err: any) {
          addStatic(
            <Box paddingX={2} marginBottom={1}>
              <Text color={theme.error}>{`Image error: ${err?.message ?? String(err)}`}</Text>
            </Box>
          );
        }
        return true;
      }
      case '/mem':
      case '/memory': {
        setError(null);
        const sub = (parts[1] ?? 'list').toLowerCase();
        if (sub === 'add') {
          const text = parts.slice(2).join(' ').trim();
          if (!text) {
            setError('Usage: /memory add <text>');
            return true;
          }
          const saved = addMemory({ text, kind: 'note', source: 'user' });
          setHelpMessage('error' in saved ? `Could not save: ${saved.error}` : `Saved memory ${saved.id}`);
          return true;
        }
        if (sub === 'forget' || sub === 'delete') {
          const target = parts.slice(2).join(' ').trim();
          if (!target) {
            setError('Usage: /memory forget <id or text>');
            return true;
          }
          const removed = forgetMemory(target);
          setHelpMessage(removed > 0 ? `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'}.` : 'No matching memory entry.');
          return true;
        }
        setHelpMessage(formatMemoryList(listMemory({ limit: 30 })).join('\n'));
        return true;
      }
      case '/verify': {
        setError(null);
        const cwd = process.cwd();
        const checks = await detectChecks({ cwd });
        if (checks.length === 0) {
          setHelpMessage('No project checks detected (package.json scripts, Cargo.toml, Makefile, pyproject.toml).');
          return true;
        }
        setHelpMessage(`Running ${checks.map((check) => check.name).join(', ')}…`);
        const results = await runChecks(checks, { cwd, stopOnFirstFailure: false });
        const report = renderCheckReport(results, checks);
        if (results.every((result) => result.status === 'pass')) setHelpMessage(report);
        else setError(report);
        return true;
      }
      case '/doctor': {
        setError(null);
        const report = await collectDoctorReport({ version: version ?? 'unknown' });
        setHelpMessage(renderDoctorReport(report));
        return true;
      }
      case '/trust': {
        setError(null);
        const canonical = trustProject(process.cwd());
        await reloadRuntimePolicy(session?.id);
        setHelpMessage(`Trusted ${canonical}. Project permission rules, hooks and commands are now active.`);
        return true;
      }
      case '/permissions': {
        // /permissions is listed in the palette, so it must not fall through
        // to the model as literal text.
        setError(null);
        const cwd = process.cwd();
        try {
          const effective = loadEffectiveRules(cwd);
          const lines = [
            `Permissions for ${cwd} (${isProjectTrusted(cwd) ? 'trusted' : 'not trusted'})`,
            ...(effective.projectError ? [`! ${effective.projectError}`] : []),
            ...describeRuleSet(effective.rules),
          ];
          setHelpMessage(lines.join('\n'));
        } catch (err: any) {
          setError(`Could not read permission rules: ${err?.message ?? String(err)}`);
        }
        return true;
      }
      case '/checkpoint': {
        const notes = getWorkingCheckpoint(session?.id);
        setHelpMessage(notes
          ? notes
          : 'No working checkpoint. The model writes one with update_working_checkpoint; it survives compaction.');
        return true;
      }
      case '/rewind': {
        setError(null);
        const steps = Number.parseInt(parts[1] ?? '0', 10);
        const target = resolveRewind(session?.id ?? 'default', Number.isFinite(steps) ? steps : 0);
        if (!target) {
          setError('Nothing to rewind yet.');
          return true;
        }
        let restored = 0;
        for (const id of checkpointsForRewind(target)) {
          const result = await runToolCall('undo', { id }, { sessionId: session?.id });
          if (!result.toLowerCase().startsWith('error')) restored++;
        }
        const kept = completionMessages.slice(0, target.messageIndex);
        setCompletionMessages(kept);
        // Rebuild scrollback from the kept messages; otherwise cards for the
        // dropped turns remain visible and clickable.
        setStaticItems([]);
        setUserScroll(0);
        replayMessagesToScrollback(addStatic, kept, theme, MAX_REPLAY_MESSAGES, columns);
        if (session) {
          session.completionMessages = kept;
          await saveSession(session);
        }
        if (session?.id) truncateTurns(session.id, target.turn - 1);
        clearWorkingCheckpoint(session?.id);
        setHelpMessage(`Rewound to turn #${target.turn}: restored ${restored} checkpoint(s) and dropped later messages.`);
        return true;
      }
      case '/undo': {
        setError(null);
        try {
          const result = await handleToolCall('undo', {}, { sessionId: session?.id });
          addToolResultView(addStatic, 'undo', {}, result, theme);
        } catch (err: any) {
          setError(`Undo failed: ${err?.message ?? String(err)}`);
        }
        return true;
      }
      default:
        return false;
    }
  }, [
    config,
    exit,
    exitWithSave,
    handleUpdate,
    session,
    completionMessages,
    allModelItems,
    providerItems,
    variantId,
    settings,
    effectiveApprovalMode,
    loadModels,
    startNewSession,
    switchSession,
    openSessionPicker,
    openSubagents,
    deleteSavedSession,
    session?.id,
    addStatic,
    showToast,
    theme,
    version,
    reloadRuntimePolicy,
    columns,
  ]);

  // Shared save path for both entry points (settings row and /theme).
  const applyTheme = useCallback(
    (name: ThemeName) => {
      const next = { ...settings, theme: name };
      setSettings(next);
      saveSettings(next);
      showToast(`Theme: ${name}`);
      setPicker(null);
      setSettingsIndex(null);
    },
    [settings, setSettings, showToast]
  );

  const applyPicker = useCallback(() => {
    if (picker === 'subagents') {
      const run = subagentRuns[clampIndex(pickerIndex, subagentRuns.length)];
      if (run) void openSubagentDetail(run.id);
      return;
    }
    if (picker === 'theme') {
      const name = THEME_NAMES[clampIndex(pickerIndex, THEME_NAMES.length)];
      if (name) applyTheme(name);
      return;
    }
    if (picker === 'statusLine') {
      const id = STATUS_LINE_ITEMS[clampIndex(pickerIndex, STATUS_LINE_ITEMS.length)];
      if (id) {
        const current = settings.statusLine ?? [...STATUS_LINE_ITEMS];
        const nextList = STATUS_LINE_ITEMS.filter((item) =>
          item === id ? !current.includes(item) : current.includes(item)
        );
        const next = { ...settings, statusLine: nextList };
        setSettings(next);
        saveSettings(next);
      }
      return; // stay open so several segments can be toggled in one visit
    }
    if (picker === 'model') {
      const item = modelItems[selectedModelIndex];
      if (item && !config) {
        // First setup: selecting a model with no config creates it.
        const providerId = pendingProviderId ?? modelProviderId;
        if (providerId) {
          finalizeFirstConfig(providerId, item.id, {
            name: item.label,
            contextWindow: item.contextWindow,
          });
        }
      } else if (item && config) {
        const providerId = pendingProviderId ?? config.provider;
        const switchingProvider = providerId !== config.provider;
        const nextConfig: Config = {
          ...config,
          provider: providerId,
          model: item.id,
          ...(switchingProvider ? { apiKey: undefined } : {}),
        };

        if (switchingProvider) {
          try {
            clientRef.current = buildClient(nextConfig);
          } catch (err: any) {
            setError(`Cannot switch provider: ${err.message}`);
            modelFetchSeqRef.current += 1;
            setModelsLoading(false);
            setModelNotice(null);
            setModelSearch('');
            setPendingProviderId(null);
            setPicker(null);
            return;
          }
        }

        setConfig(nextConfig);
        setSession((prev) =>
          prev ? { ...prev, provider: providerId, model: item.id } : prev
        );
        persistActiveSelection(providerId, item.id, {
          name: item.label,
          contextWindow: item.contextWindow,
        });
      }
      modelFetchSeqRef.current += 1;
      setModelsLoading(false);
      setModelNotice(null);
      setModelSearch('');
      setPendingProviderId(null);
      setPicker(null);
    } else if (picker === 'variant') {
      const variant = VARIANTS[clampIndex(pickerIndex, VARIANTS.length)];
      if (variant) {
        setVariantId(variant.id);
        const nextSettings = { ...settings, variant: variant.id };
        setSettings(nextSettings);
        saveSettings(nextSettings);
      }
      setPicker(null);
    } else if (picker === 'provider') {
      const item = providerItems[clampIndex(pickerIndex, providerItems.length)];
      if (!item) {
        setPicker(null);
        return;
      }
      const provider = getProvider(item.id);
      if (!provider) {
        setError(`Provider ${item.label} is not available.`);
        setPicker(null);
        return;
      }

      setPicker(null);
      if (resolveApiKey({ provider: item.id }) === null) {
        setKeyPrompt({
          providerId: item.id,
          providerName: provider.name,
          path: getActiveRuntimeConfigPath() ?? getRuntimeConfigPath('user'),
          error: null,
          busy: false,
        });
        return;
      }
      beginProviderSwitch(item.id);
    } else if (picker === 'session') {
      const item = sessionItems[clampIndex(pickerIndex, sessionItems.length)];
      setPicker(null);
      setSessionItems([]);
      if (item) void switchSession(item.id);
    }
  }, [
    picker,
    pickerIndex,
    subagentRuns,
    openSubagentDetail,
    modelItems,
    selectedModelIndex,
    providerItems,
    config,
    pendingProviderId,
    settings,
    applyTheme,
    sessionItems,
    beginProviderSwitch,
    persistActiveSelection,
    switchSession,
    finalizeFirstConfig,
    modelProviderId,
  ]);

  const handleSubmit = useCallback(async (value: string, force = false, keepInput = false) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (loading && !force) {
      // Slash commands and `!` shell escapes are actions, not prompts: queueing
      // them would run the wrong command after this turn. Keep the draft so it
      // can be retried once the agent is idle.
      if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
        showToast('Commands and ! shell are unavailable while busy — wait for this turn', 0);
        return;
      }
      // Steering: admit the prompt now and let the turn boundary deliver it.
      const admission = inboxRef.current.enqueue({
        id: `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: session?.id ?? 'default',
        text: trimmed,
        mode: 'steer',
        enqueuedAt: Date.now(),
      });
      if (!admission.ok) {
        setError(admission.error);
        return;
      }
      setInputText('');
      setInputResetKey((prev) => prev + 1);
      commandIndexRef.current = 0;
      setCommandIndex(0);
      const queueCount = inboxRef.current.pending(session?.id ?? 'default').length;
      showToast(`Queued · ${queueCount} queued — will run after this turn`, 0);
      return;
    }

    // Shell escape: `! ls` runs locally and never reaches the model.
    if (trimmed.startsWith('! ')) {
      const command = trimmed.slice(2).trim();
      if (!keepInput) {
        setInputText('');
        setInputResetKey((prev) => prev + 1);
      }
      if (!command) {
        setError('Usage: ! <command>');
        return;
      }
      await runShellCommand(command);
      return;
    }

    // Slash commands work even before a provider is configured.
    if (trimmed.startsWith('/')) {
      // Enter runs the highlighted palette row, tracked synchronously in a ref
      // (state can arrive a frame late when arrows and Enter share a burst).
      const typed = trimmed.split(/\s+/)[0];
      const matches = SLASH_COMMANDS.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(typed.toLowerCase())
      );
      const highlighted = commandItemsRef.current[
        clampIndex(commandIndexRef.current, commandItemsRef.current.length)
      ]?.label;
      const selected = highlighted
        ?? matches.find((cmd) => cmd.name.toLowerCase() === typed.toLowerCase())?.name
        ?? matches[0]?.name
        ?? typed;
      const handled = await handleSlashCommand(selected, trimmed);
      if (handled) {
        commandIndexRef.current = 0;
        setCommandIndex(0);
        if (!keepInput) {
          setInputText('');
          setInputResetKey((prev) => prev + 1);
        }
        return;
      }
    }

    // Questions about this runtime never need a model round trip, and they stay
    // answerable offline.
    const localAnswer = answerLocally(trimmed, {
      version: version ?? 'unknown',
      cwd: process.cwd(),
      ...(config?.model ? { model: config.model } : {}),
      ...(config?.provider ? { provider: config.provider } : {}),
      approvalMode: effectiveApprovalMode,
      planMode: mode === 'plan',
    });
    if (localAnswer !== null) {
      if (!keepInput) {
        setInputText('');
        setInputResetKey((prev) => prev + 1);
      }
      printMessageToScrollback(addStatic, 'user', trimmed, theme, columns);
      printMessageToScrollback(addStatic, 'assistant', localAnswer, theme, columns);
      setCompletionMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed } as Message,
        { role: 'assistant', content: localAnswer } as Message,
      ]);
      return;
    }

    // A custom command (`/review src/app.ts`) expands into the prompt that follows.
    let effectiveInput = trimmed;
    if (trimmed.startsWith('/')) {
      const [commandName, ...rest] = trimmed.slice(1).split(/\s+/);
      const custom = customCommands.find((command) => command.name.toLowerCase() === (commandName ?? '').toLowerCase());
      if (custom) {
        if (custom.handler) {
          // Plugin commands may perform an action and optionally return a
          // prompt for the agent to process instead.
          const handled = await custom.handler(rest);
          if (typeof handled === 'string' && handled.trim()) {
            effectiveInput = handled.trim();
          } else {
            if (!keepInput) {
              setInputText('');
              setInputResetKey((key) => key + 1);
            }
            return;
          }
        } else {
          effectiveInput = expandCommand(custom, rest.join(' '));
        }
      }
    }

    if (!clientRef.current || !config) {
      // No turn can start: drop the claimed queue item instead of retrying it
      // on every render, and tell the user why it was not run.
      const dropped = queuedDeliveryRef.current;
      if (dropped) {
        inboxRef.current.ack(dropped.sessionId, dropped.id);
        queuedDeliveryRef.current = null;
        showToast('Queued prompt dropped — no provider configured', 0);
      }
      deliveryInFlightRef.current = false;
      setError(API_MISSING_HINT);
      return;
    }

    if (!keepInput) {
      setInputText('');
      setInputResetKey((prev) => prev + 1); // Force TextInput to remount and clear
    }
    sessionSavedRef.current = false;
    setSearchQuery(null);
    // Acknowledge the queued prompt only now that the turn is actually
    // starting; an earlier failure leaves it pending for the next turn.
    const queued = queuedDeliveryRef.current;
    if (queued && force) {
      inboxRef.current.ack(queued.sessionId, queued.id);
      queuedDeliveryRef.current = null;
    }
    deliveryInFlightRef.current = false;
    setLoading(true);
    setIsStreaming(false);
    setStreamingText('');
    setError(null);
    setHelpMessage(null);
    setThreadErrors([]);
    setThinkingText('');
    setThinkingElapsedMs(0);
    setThinkingStartedAt(null);
    setThinkingArchived(false);
    reasoningRef.current = '';
    thinkingPinnedRef.current = false;
    setThinkingExpanded(false);
    assistantMessageRef.current = null;
    streamingBufferRef.current = { unflushedContent: '', hasFlushedAnyLine: false, lastUiUpdate: 0 };

    // Capture this run's id before any await: /new or another submit bumps
    // activeRunRef, and this run must then stop touching shared state.
    const runId = activeRunRef.current;

    // Print the user message directly to scrollback so it is selectable/copyable.
    // We still push it into completionMessages for session saving. In plan mode
    // the model gets an explicit instruction it does not see in the transcript.
    const userText = mode === 'plan' ? `${PLAN_MODE_NOTE}\n\n${effectiveInput}` : effectiveInput;
    const userMessage: Message = { role: 'user', content: userText };
    // A /image attachment rides along as a separate user message note.
    const image = pendingImageRef.current;
    const imageMessage: Message | null = image
      ? { role: 'user', content: `[Attached image: ${image.path}] ${image.dataUrl}` }
      : null;
    pendingImageRef.current = null;
    const nextMessages = imageMessage
      ? [...completionMessages, userMessage, imageMessage]
      : [...completionMessages, userMessage];
    printMessageToScrollback(addStatic, 'user', trimmed, theme, columns);

    // Append-only journal + per-turn manifest: replay and /rewind both need them.
    const turnSessionId = session?.id ?? 'default';
    appendJournal(turnSessionId, { type: 'user', content: trimmed.slice(0, 2_000) });
    beginTurn(turnSessionId, completionMessages.length, trimmed);

    setCompletionMessages((prev) =>
      imageMessage ? [...prev, userMessage, imageMessage] : [...prev, userMessage]
    );
    lastSubmitRef.current = trimmed;
    // Prompt history survives restarts; consecutive duplicates are collapsed.
    appendHistory(trimmed);
    historyNavigatorRef.current?.replace(loadHistory());

    // Reset assistant message tracker (streamed indices were reset above)
    assistantMessageRef.current = null;

    try {
      const basePricing = getModelPricing(config.provider, config.model);
      // Remote model catalogs (OpenRouter, custom endpoints) can carry a real
      // context window that the static registry does not know about. Prefer it
      // so context% and compaction use the active model's actual limit.
      const activeWindow = getModelPaletteInfo(config.provider, config.model)?.contextWindow;
      const pricing = basePricing && activeWindow && activeWindow > 0
        ? { ...basePricing, contextWindow: activeWindow }
        : basePricing;
      const requestDefaults = getRequestDefaultParams(config.provider, config.model);
      const chosenVariant = VARIANTS.find((item) => item.id === variantId);
      if (chosenVariant?.reasoningEffort) {
        requestDefaults.reasoning_effort = chosenVariant.reasoningEffort;
      } else {
        // "none" must mean none, even when the model config has a default.
        delete requestDefaults.reasoning_effort;
      }

      // Create abort controller for this completion
      abortControllerRef.current = new AbortController();

      const updatedMessages = await runAgenticLoop(
        clientRef.current,
        config.model,
        nextMessages,
        effectiveInput,
        handleAgentEventWithSubAgents,
        {
          pricing: pricing || undefined,
          abortSignal: abortControllerRef.current.signal,
          sessionId: session?.id,
          requestDefaults,
          compactThreshold: settings.compactThreshold,
          hooks: hooksRef.current,
          toolPolicy: buildToolPolicy(),
        }
      );

      // A newer run (or /new) superseded this one: drop the result instead of
      // writing the old conversation into the current session.
      if (runId !== activeRunRef.current) return;

      // Final update to ensure we have the complete message history
      setCompletionMessages(updatedMessages);
      const finishedTurn = endTurn(turnSessionId);
      appendJournal(turnSessionId, {
        type: 'assistant',
        data: { messages: updatedMessages.length, model: config.model },
      });

      // Optional finish gate: only after a turn that actually touched files, and
      // only when enabled, so a normal session never spawns a test suite.
      const autoverifyEnabled = settings.autoverify === true || process.env.BITACODE_AUTOVERIFY === '1';
      if (autoverifyEnabled && finishedTurn && finishedTurn.paths.length > 0) {
        try {
          const cwd = process.cwd();
          const checks = await detectChecks({ cwd });
          if (checks.length > 0) {
            addToolResultView(addStatic, 'Autoverify', { checks: checks.map((c) => c.name) }, 'running…', theme);
            const results = await runChecks(checks, { cwd, stopOnFirstFailure: false });
            const report = renderCheckReport(results, checks);
            if (results.every((result) => result.status === 'pass')) setHelpMessage(report);
            else setError(report);
          }
        } catch (err: any) {
          logger.warn('Autoverify failed to run', { error: String(err?.message ?? err) });
        }
      }

      // Background jobs report completion as synthetic user input so the next
      // turn sees the result without the model having to poll. Each job is
      // surfaced once; failures here are cosmetic and never fail the turn.
      try {
        const notices: string[] = [];
        for (const job of listBackgroundJobs()) {
          if (job.status === 'running' || notifiedJobsRef.current.has(job.id)) continue;
          const text = formatTaskNotification(job);
          if (text) {
            notices.push(text);
            notifiedJobsRef.current.add(job.id);
          }
        }
        if (notices.length > 0) {
          for (const notice of notices) {
            updatedMessages.push({ role: 'user', content: notice } as Message);
          }
          showToast(`${notices.length} background job${notices.length === 1 ? '' : 's'} finished`, 0);
        }
      } catch (error) {
        logger.warn('Could not collect background job notifications', { error: String(error) });
      }

      // Update session
      if (session) {
        session.completionMessages = updatedMessages;
        session.todos = getTodosForSession(session.id);
        session.title = generateTitle(updatedMessages);
        session.provider = config.provider;
        session.model = config.model;
        session.variant = variantId;
        session.subAgentActivities = subAgentActivitiesRef.current;
        await saveSession(session);
        sessionSavedRef.current = true;
      }
    } catch (err: any) {
      if (runId !== activeRunRef.current) return;
      setError(err.message);
    } finally {
      deliveryInFlightRef.current = false;
      if (runId === activeRunRef.current) {
        setLoading(false);
      }
    }
  }, [
    loading, config, completionMessages, session, handleSlashCommand, addStatic, rows,
    commandItems, commandIndex, variantId, settings, handleAgentEventWithSubAgents,
    mode, runShellCommand, theme, getModelPaletteInfo, columns, buildToolPolicy,
  ]);

  // Any command path can reject; never let that become an unhandled rejection
  // that kills the TUI after a turn.
  const submitSafely = useCallback(
    async (value: string, force = false, keepInput = false) => {
      try {
        await handleSubmit(value, force, keepInput);
      } catch (err: any) {
        setError(`Request failed: ${err.message}`);
        setLoading(false);
      }
    },
    [handleSubmit]
  );

  // Deliver prompts that arrived while a turn was running. Steers are admitted
  // once and removed on delivery, so a re-render can never replay them.
  useEffect(() => {
    if (loading || deliveryInFlightRef.current) return;
    const sessionId = session?.id ?? 'default';
    // Peek instead of deliverNext: the item is acknowledged in handleSubmit
    // once the turn has actually started (`force` marks the queued path).
    const next = inboxRef.current.pending(sessionId)[0];
    if (!next) return;
    deliveryInFlightRef.current = true;
    queuedDeliveryRef.current = { id: next.id, sessionId };
    showToast(`Running queued prompt: ${next.text.slice(0, 40)}`, 0);
    void submitSafely(next.text, true, true);
  }, [loading, session?.id, showToast, submitSafely]);

  // Config files can change while the app is open. Watching is best-effort:
  // an unsupported platform simply leaves the old behaviour (restart to apply).
  useEffect(() => {
    const watcher = createConfigWatcher(defaultWatchTargets(), (event) => {
      showToast(`${event.label} changed — restart to apply`, 0);
    });
    watcher.start();
    return () => watcher.stop();
  }, [showToast]);

  // User themes are optional. The first valid file wins; a bad palette is
  // ignored by registerCustomTheme and the built-in palette stays in place.
  useEffect(() => {
    try {
      const found = discoverThemeFiles({
        extraDirs: settings.themePath ? [dirname(settings.themePath)] : [],
      });
      if (!found.ok) return;
      // Prefer the explicitly configured file over discovery's alphabetical
      // first match in the same directory.
      const exact = settings.themePath
        ? found.value.find((file) =>
            file.path === settings.themePath || basename(file.path) === basename(settings.themePath!)
          )
        : undefined;
      const ordered = exact ? [exact, ...found.value.filter((file) => file !== exact)] : found.value;
      for (const file of ordered) {
        if (registerCustomTheme('custom', file.raw)) {
          showToast('Custom theme loaded (select "custom")', 0);
          break;
        }
      }
    } catch (error) {
      logger.warn('Custom theme discovery failed', { error: String(error) });
    }
  }, [settings.themePath, showToast]);

  // One tick per second while busy: drives the activity strip's elapsed time
  // without touching the transcript or the token stream.
  useEffect(() => {
    const active = loading || isStreaming || Boolean(activeTool);
    if (!active) {
      setBusyStartedAt(null);
      return;
    }
    setBusyStartedAt((prev) => prev ?? Date.now());
    const timer = setInterval(() => setBusyClock(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [loading, isStreaming, activeTool]);

  // ── Layout and the live conversation tail ────────────────────────────
  // Thinking and the streaming tail are conversation content, not a footer
  // panel. They are appended to the measured transcript flow so they render
  // directly after the message that produced them, instead of being pinned to
  // the bottom of the screen with an empty gap above.
  const layout = resolveLayout(columns, rows);
  const { paletteWindow, visibleTodos, gutter, dense } = layout;
  const composerWidth = composerTextWidth(layout.inputWidth, layout.showSubmitHint);
  // Grow with the text, but never take more than about a third of the screen:
  // a long paste scrolls inside the composer instead of eating the transcript.
  // Keep enough room for a draft to wrap before PromptInput starts scrolling
  // its own row window (which hides earlier typed lines). The old /2 budget
  // gave only 1-2 rows on short terminals, so normal typing looked like text
  // vanishing upward.
  const composerMaxRows = Math.max(2, Math.min(12, rows - 6));

  // Provider-driven only: the block appears when the model actually streams
  // reasoning, never just because a request is in flight.
  const hasThinkingBlock = initialized && !thinkingArchived && thinkingText.length > 0;
  const thinkingActive = thinkingStartedAt !== null && !thinkingArchived;
  const thinkingRows = hasThinkingBlock
    ? thinkingBlockHeight(thinkingText, thinkingExpanded, columns, rows)
    : 0;
  const todoRows = todoPanelRows(todos, visibleTodos);
  const helpRows = helpMessage ? helpMessage.split('\n').length + 3 : 0;
  const subAgentRows = showSubAgentPanel ? subAgentActivityRows(subAgentActivities) : 0;

  // Dialogue rows for the saved-transcript picker. Status colours come from the
  // active palette so the list matches every other themed surface.
  const subagentItems: DialogItem[] = subagentRuns.map((run) => {
    const icon = run.status === 'done' ? '✓' : run.status === 'error' ? '✗' : '■';
    const color = run.status === 'done' ? theme.success : run.status === 'error' ? theme.error : theme.info;
    const elapsed = Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt);
    const duration = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
    const type = run.agentType ? `[${run.agentType}] ` : '';
    return {
      id: run.id,
      label: `${icon} ${type}${run.task}`,
      description: `${run.messageCount} msgs · ${duration} · ${new Date(run.startedAt).toLocaleTimeString()}`,
      color,
    };
  });

  // Activity indicator: exactly one reserved row above the composer while the
  // agent is working. Nothing is ever drawn on top of the input.
  const busy = loading || isStreaming || Boolean(activeTool);
  const liveActivity: LiveActivity = activeTool
    ? 'tool'
    : isStreaming
      ? 'streaming'
      : loading
        ? 'thinking'
        : 'waiting';
  const statusRows = busy ? 1 : 0;
  const busyElapsedMs = busyStartedAt !== null ? Math.max(0, busyClock - busyStartedAt) : 0;

  // Any interactive prompt owns the live area. One dialog owns the whole frame
  // so its card floats on a clean canvas instead of competing with the strips.
  const dialogActive =
    subagentDetail !== null ||
    picker !== null ||
    settingsIndex !== null ||
    keyPrompt !== null ||
    pendingApproval !== null ||
    pendingAsk !== null;

  // ── Non-modal strips directly above the composer ──────────────────────
  // Their rows are charged to the live-area budget so an open shortcut or log
  // panel can never push the composer off screen.
  const hintRows = initialized && !dialogActive ? 1 : 0;
  const queueCount = inboxRef.current.pending(session?.id ?? 'default').length;
  const hintText = (() => {
    try {
      const ctx: HintContext = {
        busy,
        streaming: isStreaming,
        planMode: mode === 'plan',
        picker,
        dialog: pendingApproval
          ? 'approval'
          : pendingAsk
            ? 'ask'
            : keyPrompt
              ? 'key'
              : settingsIndex !== null
                ? 'settings'
                : subagentDetail
                  ? 'subagent'
                  : null,
        searchActive: searchQuery !== null,
        queueCount,
        compact: dense,
      };
      return formatHints(ctx, { width: columns, keybinds: settings.keybindings });
    } catch {
      return '';
    }
  })();
  // formatHints owns the wording; keep an explicit fallback so the queue cue
  // is never lost if the helper ignores `queueCount`.
  const hintLine = queueCount > 0 && !/queued/i.test(hintText)
    ? `${hintText}${hintText ? ' · ' : ''}${queueCount} queued`
    : hintText;

  const shortcutLines = showShortcuts && !dialogActive && !busy
    ? (() => {
        try {
          return renderShortcutPanel(columns, settings.keybindings) ?? [];
        } catch {
          return [] as string[];
        }
      })()
    : [];
  const shortcutRows = shortcutLines.length > 0 ? shortcutLines.length + 1 : 0;

  const errorLines = showErrorPanel && !dialogActive
    ? (() => {
        try {
          return getRecentLogs(12).map((entry) => {
            const level = ['ERR', 'WARN', 'INFO', 'DBG', 'TRC'][entry.level] ?? String(entry.level);
            const context = entry.context && Object.keys(entry.context).length > 0
              ? ` ${JSON.stringify(entry.context).slice(0, 80)}`
              : '';
            return `${level.padEnd(4)} ${entry.timestamp} ${String(entry.message).slice(0, 140)}${context}`;
          });
        } catch {
          return [] as string[];
        }
      })()
    : [];
  const errorPanelRows = showErrorPanel && !dialogActive
    ? Math.min(12, Math.max(1, errorLines.length)) + 3
    : 0;

  // Overlays are informational: a busy turn or a dialog takes precedence.
  useEffect(() => {
    if (busy || dialogActive) setShowShortcuts(false);
  }, [busy, dialogActive]);

  // Panels that stay under the transcript (todos, help, child agents) reserve
  // their own rows; thinking and streaming live inside the transcript now.
  const area = splitLiveArea(frameHeight, {
    todos: todoRows,
    thinking: 0,
    help: helpRows + hintRows + shortcutRows + errorPanelRows,
    streaming: subAgentRows,
    status: statusRows,
    dense,
    // Rows added by a grown composer beyond its single-line default.
    composer: Math.max(0, composerRows - 1),
  });
  const maxStreamRows = Math.max(2, Math.min(MAX_LIVE_STREAM_ROWS, area.transcriptRows));
  const streamingIsDiff = isStreaming && looksLikeDiff(streamingText);
  const liveStreamWidth = Math.max(1, columns - gutter * 2);
  // Format the WHOLE reply, then clip only the view to its tail. Clipping the
  // raw text first used to strip table headers and fence openers, so markdown
  // only looked right after `done` when the full text was formatted again.
  const liveStreamFullRows = wrappedRowCount(streamingText, liveStreamWidth);
  const liveStreamTextRows = Math.min(liveStreamFullRows, maxStreamRows);
  const liveStreamTrimRows = Math.max(0, liveStreamFullRows - liveStreamTextRows);
  const liveStreamRows = !isStreaming
    ? 0
    : streamingIsDiff
      ? Math.min(maxStreamRows, 10) + 4
      : liveStreamTextRows + (dense ? 0 : 1);
  const liveStreamNode = !isStreaming ? null : streamingIsDiff ? (
    <DiffView
      header="Streaming diff"
      diff={clipToRows(streamingText, Math.max(2, maxStreamRows - 3), columns)}
      maxRows={Math.max(2, maxStreamRows - 3)}
    />
  ) : (
    <Box height={liveStreamTextRows + (dense ? 0 : 1)} overflow="hidden" flexShrink={0}>
      <Box paddingX={gutter} paddingBottom={dense ? 0 : 1} marginTop={-liveStreamTrimRows}>
        <Text wrap="wrap">
          {renderFormattedText(streamingText, liveStreamWidth, theme)}
          <Text dimColor>▍</Text>
        </Text>
      </Box>
    </Box>
  );

  // Live rows join the flow only for the normal transcript. /find keeps its
  // result set to saved messages so a moving stream cannot change the matches.
  const liveItems: StaticItem[] = [];
  const liveRowMap = new Map<string, number>();
  if (!searchQuery) {
    if (hasThinkingBlock) {
      liveItems.push({
        id: LIVE_THINKING_ID,
        node: (
          <ThinkingBlock
            text={thinkingText}
            expanded={thinkingExpanded}
            active={thinkingActive}
            animate={settings.animations}
            frame={spinnerFrame}
            columns={columns}
            rows={rows}
            elapsedMs={thinkingElapsedMs}
          />
        ),
      });
      liveRowMap.set(LIVE_THINKING_ID, Math.max(1, thinkingRows));
    }
    if (isStreaming && liveStreamNode) {
      liveItems.push({ id: LIVE_STREAM_ID, node: liveStreamNode });
      liveRowMap.set(LIVE_STREAM_ID, Math.max(1, liveStreamRows));
    }
  }

  // /find filters the scrollback view without deleting history.
  const searchMatches = searchQuery
    ? staticItems.filter((item) =>
        nodeText(item.node).toLowerCase().includes(searchQuery.toLowerCase())
      )
    : staticItems;

  // Re-measure the viewport only when something that changes its height
  // changes. Panel heights (not just item counts) belong here: two todos or
  // two help lines of different length can wrap into a different row count.
  const liveAreaSignature = [
    rows,
    columns,
    resizeTick,
    thinkingText.length,
    thinkingExpanded,
    streamingText.length,
    thinkingRows,
    todoRows,
    helpRows,
    subAgentRows,
    searchMatches.length,
    staticItems.length,
    searchQuery?.length ?? 0,
    hintRows,
    shortcutRows,
    errorPanelRows,
    loading ? 1 : 0,
    isStreaming ? 1 : 0,
    activeTool ?? '',
    error ?? '',
    threadErrors.length,
    decodeTps ?? '',
    helpMessage ?? '',
    pendingApproval ? 1 : 0,
    pendingAsk ? 1 : 0,
    keyPrompt ? 1 : 0,
    picker ?? '',
    settingsIndex !== null ? 1 : 0,
    initialized ? 1 : 0,
    config ? 1 : 0,
    subAgentActivities.length,
    showSubAgentPanel ? 1 : 0,
    updateNotice ? 1 : 0,
    mode,
    toast?.length ?? 0,
    composerRows,
  ].join(':');

  useEffect(() => {
    if (!viewportRef.current) return;
    const height = measureElement(viewportRef.current).height;
    if (height > 0 && height !== viewportRows) {
      setViewportRows(height);
    }
  }, [liveAreaSignature]);
  // Rows for an item: live rows use their estimate (their content changes every
  // frame, so a cached measurement would lag a growing stream), while archived
  // items use the height Ink measured for them.
  const sizedItems = searchMatches.map((item) => ({
    item,
    rows: resolveItemRows({
      live: liveRowMap.get(item.id),
      node: nodeHeight(item.node),
      measured: measuredHeights[item.id],
      fallback: fallbackItemRows(item.node),
    }),
  }));
  // The transcript is one flow: archived messages followed by the live tail.
  const liveSized = liveItems.map((item) => ({
    id: item.id,
    rows: liveRowMap.get(item.id) ?? fallbackItemRows(item.node),
  }));
  const flowSized = [
    ...sizedItems.map((entry) => ({ id: entry.item.id, rows: entry.rows })),
    ...liveSized,
  ];
  const transcriptRows = flowSized.reduce((total, entry) => total + entry.rows, 0);
  const unmeasuredItems = staticItems.filter((item) => measuredHeights[item.id] === undefined);
  const restoringTranscript =
    measuringTranscript && staticItems.length > 0 && unmeasuredItems.length > 0;
  // One row of the viewport is reserved for top breathing room so the first
  // message never touches the screen edge. Clamp and slice against the SAME
  // window, otherwise the oldest row is unreachable (max used the full viewport
  // while the slice used viewport - pad).
  const TOP_PAD = 1;
  const windowRows = Math.max(1, viewportRows - TOP_PAD);
  const maxUserScroll = maxScrollOffset(transcriptRows, windowRows);
  const effectiveUserScroll = clampScroll(userScroll, maxUserScroll);
  // Only the rows inside the viewport are rendered. Ink's negative marginTop
  // over-scrolls and snaps when used to scroll the whole view, so the window is
  // sliced from measured rows; a margin is used only to clip one partial item.
  const rowWindow = visibleRowWindow(transcriptRows, windowRows, effectiveUserScroll);
  // Map the row window onto items. Items below the viewport are skipped
  // entirely, so a long session stays cheap to render.
  const flowById = new Map<string, StaticItem>();
  for (const item of staticItems) flowById.set(item.id, item);
  for (const item of liveItems) flowById.set(item.id, item);
  const windowSlice = sliceItemsToWindow(flowSized, rowWindow.first, rowWindow.last);
  const visibleItems = windowSlice.items
    .map((entry) => flowById.get(entry.id))
    .filter((item): item is StaticItem => Boolean(item));
  const visibleRowItems = windowSlice.items.map((entry) => ({
    id: entry.id,
    rows: entry.rows,
  }));
  const trimTop = windowSlice.trimTop;
  // The window is sliced by measured rows, but measurement can lag a frame (a
  // freshly archived card, a resize). Padding the region to exactly the
  // viewport height makes the transcript a solid block: nothing from a previous
  // frame can survive underneath it, and text can never be painted below the
  // composer.
  const usedRows = visibleRowItems.reduce((total, entry) => total + entry.rows, 0) - trimTop;
  const fillerRows = transcriptFillerRows(viewportRows, usedRows);

  // Input handlers can fire faster than React re-renders (wheel bursts), so
  // keep the scroll position in a ref and clamp against the latest layout.
  const scrollStateRef = useRef({ userScroll: effectiveUserScroll, maxUserScroll });
  scrollStateRef.current.maxUserScroll = maxUserScroll;
  // Only sync the ref from committed state. Writing it during render would
  // stomp a scroll that already happened this frame, which made the wheel
  // jump backwards on fast terminals.
  useEffect(() => {
    scrollStateRef.current.userScroll = effectiveUserScroll;
  }, [effectiveUserScroll]);

  const scrollTo = useCallback((next: number) => {
    const clamped = clampScroll(next, scrollStateRef.current.maxUserScroll);
    scrollStateRef.current.userScroll = clamped;
    setUserScroll(clamped);
  }, []);
  const scrollBy = useCallback(
    (amount: number) => {
      scrollTo(scrollStateRef.current.userScroll + amount);
    },
    [scrollTo]
  );

  // New transcript rows grow the document. Keep the current view anchored
  // unless the user is already pinned to the bottom.
  const transcriptRowsRef = useRef(transcriptRows);
  useEffect(() => {
    const delta = transcriptRows - transcriptRowsRef.current;
    transcriptRowsRef.current = transcriptRows;
    if (delta !== 0) {
      setUserScroll((prev) => {
        const next = scrollAfterGrowth(prev, delta, scrollStateRef.current.maxUserScroll);
        scrollStateRef.current.userScroll = next;
        return next;
      });
    }
  }, [transcriptRows]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exitWithSave();
      return;
    }

    // The transcript inspector owns its own keys (arrows/page/s/esc) while open.
    if (subagentDetail) return;

    // An approval owns the keyboard: Select handles arrows/enter and the prompt
    // handles 1/2/3/Esc. Nothing below may scroll, submit or abort underneath it.
    if (pendingApproval) return;

    // A question/form owns the keyboard too: AskPrompt handles its own Esc,
    // and App must not fall through to abort the turn underneath it.
    if (pendingAsk) return;

    // F12 toggles a compact log/details panel. No modal, no input captured.
    if (canonicalPressed(input, key).endsWith('f12')) {
      setShowErrorPanel((prev) => !prev);
      return;
    }

    // API key prompt owns text input; only Esc (when idle) is handled here.
    if (keyPrompt) {
      if (key.escape && !keyPrompt.busy) setKeyPrompt(null);
      return;
    }

    // Settings panel: arrows move, enter toggles, esc closes.
    if (settingsIndex !== null) {
      if (key.upArrow) {
        setSettingsIndex((index) => (index === null ? 0 : (index - 1 + settingItems.length) % settingItems.length));
        return;
      }
      if (key.downArrow) {
        setSettingsIndex((index) => (index === null ? 0 : (index + 1) % settingItems.length));
        return;
      }
      if (key.return) {
        toggleSetting(settingsIndex);
        return;
      }
      if (key.escape) {
        setSettingsIndex(null);
      }
      return;
    }

    // Model/variant pickers: arrows move, enter applies, esc cancels.
    if (picker) {
      if (isMouseReport(input)) {
        // Click a row in the sub-agent list to inspect it. The card is centred
        // in the live area, so map the terminal row back to the dialog's list.
        if (picker === 'subagents' && subagentRuns.length > 0 && rows > 10) {
          const press = getLeftMousePress(input);
          if (press) {
            const clicked = pickerClickIndex({
              rows,
              count: subagentRuns.length,
              pickerIndex,
              maxVisible: paletteWindow,
              pressY: press.y,
            });
            if (clicked !== null) {
              setPickerIndex(clicked);
              void openSubagentDetail(subagentRuns[clicked].id);
            }
          }
        }
        return;
      }

      if (picker === 'session') {
        if (pendingSessionDelete) {
          const answer = input.toLowerCase();
          if (answer === 'y') {
            const target = pendingSessionDelete;
            setPendingSessionDelete(null);
            void deleteSavedSession(target.id, true);
          } else if (answer === 'n' || key.escape) {
            setPendingSessionDelete(null);
          }
          return;
        }
        if (input.toLowerCase() === 'd') {
          const item = sessionItems[clampIndex(pickerIndex, sessionItems.length)];
          if (item) setPendingSessionDelete({ id: item.id, label: item.label });
          return;
        }
      }

      // The model picker doubles as a search box.
      if (picker === 'model') {
        if (key.backspace || key.delete) {
          setModelSearch((prev) => Array.from(prev).slice(0, -1).join(''));
          setPickerIndex(0);
          return;
        }
        if (
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !key.escape &&
          !key.tab &&
          !key.return &&
          !key.upArrow &&
          !key.downArrow
        ) {
          setModelSearch((prev) => prev + stripMouseReports(input));
          setPickerIndex(0);
          return;
        }
      }

      // The theme picker also accepts 1-5 as a direct pick.
      if (picker === 'theme' && /^[1-9]$/.test(input) && Number(input) <= THEME_NAMES.length) {
        const name = THEME_NAMES[Number(input) - 1];
        if (name) applyTheme(name);
        return;
      }

      const count = picker === 'provider'
        ? providerItems.length
        : picker === 'model'
          ? modelItems.length
          : picker === 'session'
            ? sessionItems.length
            : picker === 'subagents'
              ? subagentRuns.length
              : picker === 'theme'
                ? THEME_NAMES.length
                : picker === 'statusLine'
                  ? STATUS_LINE_ITEMS.length
                  : variantItems.length;
      if (count > 0) {
        if (key.upArrow) {
          setPickerIndex((index) => (index - 1 + count) % count);
          return;
        }
        if (key.downArrow) {
          setPickerIndex((index) => (index + 1) % count);
          return;
        }
      }
      if (key.return) {
        if (count > 0) applyPicker();
        return;
      }
      if (key.escape) {
        if (picker === 'statusLine') {
          setSettingsIndex(SETTING_KEYS.indexOf('statusLine'));
        }
        modelFetchSeqRef.current += 1;
        setPicker(null);
        setPendingProviderId(null);
        setModelNotice(null);
        setModelSearch('');
        setModelsLoading(false);
        setSessionItems([]);
        setSessionsLoading(false);
        setSubagentRuns([]);
        setSubagentDetail(null);
        setPendingSessionDelete(null);
      }
      return;
    }

    // `?` on an empty draft opens the non-modal shortcut sheet. Pressing it
    // again closes the sheet and inserts a literal `?` into the composer. The
    // guard makes PromptInput ignore the same keystroke so it is not doubled.
    if (input === '?' && !key.ctrl && !key.meta && (showShortcuts || inputTextRef.current === '')) {
      shortcutGuardRef.current = true;
      queueMicrotask(() => { shortcutGuardRef.current = false; });
      if (showShortcuts) {
        setShowShortcuts(false);
        setInputText('?');
        setInputResetKey((prev) => prev + 1);
      } else {
        setShowShortcuts(true);
        setInputText('');
      }
      return;
    }

    // Terminal mouse report (SGR): wheel scrolls the transcript, a left press
    // inside the live thinking block toggles it, everything else is ignored.
    // While a dialog owns the frame nothing underneath may react to a click.
    if (isMouseReport(input)) {
      if (dialogActive) return;
      const wheel = getWheelDelta(input);
      if (wheel !== 0) {
        scrollBy(-wheel * 3);
        return;
      }
      const press = getLeftMousePress(input);
      if (press) {
        // Transcript clicks toggle an archived thought/shell card. Clicks that
        // land in transcript padding are swallowed instead of leaking into the
        // live thinking block below.
        if (press.y <= viewportRows) {
          const clickRow = press.y - 1;
          // Use the boxes Ink actually laid out. Measured heights can lag one
          // render behind a new or expanded card, and stale rows send clicks
          // to the wrong transcript item.
          const layoutItems = visibleItems.map((item) => {
            const node = entryNodesRef.current.get(item.id);
            return {
              id: item.id,
              top: node?.yogaNode?.getComputedTop?.() as number | undefined,
              height: node?.yogaNode?.getComputedHeight?.() as number | undefined,
            };
          });
          const layoutHit = layoutItems.find(
            (item) =>
              typeof item.top === 'number' &&
              typeof item.height === 'number' &&
              clickRow >= item.top &&
              clickRow < item.top + item.height
          );
          // The first item is clipped, not preceded by a blank spacer, so give
          // the fallback its reduced visible height and no trim offset.
          const hitItems =
            trimTop > 0 && visibleRowItems.length > 0
              ? [
                  { ...visibleRowItems[0], rows: Math.max(0, visibleRowItems[0].rows - trimTop) },
                  ...visibleRowItems.slice(1),
                ]
              : visibleRowItems;
          const clickedId = layoutHit?.id ?? itemAtViewportRow(hitItems, clickRow, TOP_PAD, 0);
          if (clickedId === LIVE_THINKING_ID) {
            thinkingPinnedRef.current = true;
            setThinkingExpanded((expanded) => !expanded);
            return;
          }
          if (clickedId) toggleStaticItem(clickedId);
          return;
        }
        // Below the transcript is the composer: a click positions the caret.
        if (!dialogActive && initialized) {
          const textLeft = Math.floor((columns - layout.inputWidth) / 2) + 3;
          const col = Math.max(0, press.x - 1 - textLeft);
          setCaretRequest((prev) => ({ col, nonce: (prev?.nonce ?? 0) + 1 }));
        }
      }
      return;
    }

    // Global shortcuts. Every KeyAction is resolved through resolveKeybind, so
    // user overrides work even when they differ from the built-in binding (and
    // defaults such as settings:ctrl+o / search:ctrl+f are handled too). canonical
    // keys make tab/esc/arrows usable as bindings. a/e/u/w stay in PromptInput.
    const dismissible =
      !picker && settingsIndex === null && !keyPrompt && !pendingApproval && !pendingAsk;
    if (dismissible) {
      // Tab inside an @mention belongs to completion, not to the mode toggle.
      if (key.tab && findMentionToken(inputText, inputText.length)) return;
      if (key.tab) {
        // Tab completes the highlighted slash command (the palette advertises
        // this); otherwise it toggles build <-> plan mode.
        const highlighted = commandItemsRef.current[
          clampIndex(commandIndexRef.current, commandItemsRef.current.length)
        ]?.label;
        if (inputTextRef.current.startsWith('/') && highlighted) {
          setInputText(highlighted);
          setInputResetKey((prev) => prev + 1);
          commandIndexRef.current = 0;
          setCommandIndex(0);
          return;
        }
        const next = mode === 'build' ? 'plan' : 'build';
        setMode(next);
        showToast(next === 'plan' ? 'PLAN MODE — no file changes' : 'BUILD MODE', 0);
        return;
      }

      const pressed = canonicalPressed(input, key);
      const keybindings = (settings.keybindings ?? {}) as Record<KeyAction, string>;
      const toggleHelp = () =>
        setHelpMessage((prev) => (prev ? null : buildHelpText(effectiveApprovalMode)));
      const copyLastMessage = () => {
        const card = visibleItems[visibleItems.length - 1];
        const text = card ? nodeText(card.node) : '';
        if (text) {
          void copyToClipboard(text);
          showToast('Copied message', 0);
        }
      };
      const retryLast = () => {
        const last = lastSubmitRef.current;
        if (!last) return;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        activeRunRef.current += 1;
        setLoading(false);
        setIsStreaming(false);
        setStreamingText('');
        setActiveTool(null);
        setInputText(last);
        setInputResetKey((prev) => prev + 1);
        showToast(`Retrying: ${last.slice(0, 60)}`, 0);
        void submitSafely(last, true, true);
      };
      const editLast = () => {
        const lastUser = [...completionMessages]
          .reverse()
          .find((message) => message.role === 'user' && typeof message.content === 'string');
        if (lastUser && typeof lastUser.content === 'string') {
          const text = lastUser.content
            .replace(PLAN_MODE_NOTE, '')
            .replace(/^\[Attached image:[^\]]*\]\s*\S+\s*/, '')
            .trim();
          setInputText(text);
          setInputResetKey((prev) => prev + 1);
          showToast('Loaded last message — edit and press Enter', 0);
        }
      };

      const actionRunners: Array<[KeyAction, () => void]> = [
        ['newSession', () => void handleSlashCommand('/new')],
        ['sessions', () => openSessionPicker()],
        ['model', () => void handleSlashCommand('/model')],
        ['provider', () => void handleSlashCommand('/provider')],
        ['help', toggleHelp],
        ['settings', () => setSettingsIndex(0)],
        ['subagents', () => void handleSlashCommand('/subagents')],
        ['clearInput', () => {
          setInputText('');
          setInputResetKey((prev) => prev + 1);
          commandIndexRef.current = 0;
          setCommandIndex(0);
        }],
        ['clearTranscript', () => clearTranscriptAndRedraw()],
        ['thinking', () => {
          if (thinkingText) {
            thinkingPinnedRef.current = true;
            setThinkingExpanded((expanded) => !expanded);
          }
        }],
        ['retry', retryLast],
        ['copyLast', copyLastMessage],
        ['editLast', editLast],
        ['search', () => void handleSlashCommand('/search')],
      ];
      for (const [action, run] of actionRunners) {
        if (pressed !== resolveKeybind(keybindings, action)) continue;
        run();
        return;
      }

      // Legacy fallbacks with no KeyAction: variant, help via `/`, settings
      // via raw ctrl+, byte, session list via `q`, card collapse via `e`, and
      // transcript scrolling via b/f.
      if (key.ctrl || key.meta || input === '\x1c' || input === '\x1f') {
        const pageRows = Math.max(1, Math.floor(viewportRows / 2));
        switch (input === '\x1c' ? ',' : input === '\x1f' ? '/' : input) {
          case 'v': void handleSlashCommand('/variant'); return;
          case '/': toggleHelp(); return;
          case ',': void handleSlashCommand('/settings'); return;
          case 'q': void openSessionPicker(); return;
          case 'e': {
            const anyExpanded = staticItems.some((item) => item.toggle && item.expanded);
            setStaticItems((prev) =>
              prev.map((item) => {
                if (!item.toggle) return item;
                const expanded = !anyExpanded;
                return { ...item, expanded, node: expanded ? item.toggle.expanded : item.toggle.collapsed };
              })
            );
            showToast(anyExpanded ? 'Collapsed all cards' : 'Expanded all cards', 0);
            return;
          }
          case 'b': scrollBy(pageRows); return;
          case 'f': scrollBy(-pageRows); return;
        }
      }
    }

    // Ctrl/Alt+Up loads the last user message into the composer for editing.
    if (
      !picker && settingsIndex === null && !pendingApproval && !pendingAsk &&
      key.upArrow && (key.ctrl || key.meta)
    ) {
      const lastUser = [...completionMessages]
        .reverse()
        .find((message) => message.role === 'user' && typeof message.content === 'string');
      if (lastUser && typeof lastUser.content === 'string') {
        const text = lastUser.content.replace(PLAN_MODE_NOTE, '').replace(/^\[Attached image:[^\]]*\]\s*\S+\s*/, '').trim();
        setInputText(text);
        setInputResetKey((prev) => prev + 1);
        showToast('Loaded last message — edit and press Enter', 0);
      }
      return;
    }

    // Scroll the transcript without moving the input/footer. Arrows also work
    // when Termux sends them for touch swipes.
    if (!picker && settingsIndex === null && !pendingApproval && !pendingAsk && !(inputTextRef.current.startsWith('/') && commandItems.length > 0)) {
      const pageRows = Math.max(1, Math.floor(viewportRows / 2));
      if (key.pageUp || (key.ctrl && input === 'b')) {
        scrollBy(pageRows);
        return;
      }
      if (key.pageDown || (key.ctrl && input === 'f')) {
        scrollBy(-pageRows);
        return;
      }
      if (key.home) {
        scrollTo(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (key.end) {
        scrollTo(0);
        return;
      }
    }

    // Esc clears an active /find transcript filter.
    if (key.escape && searchQuery) {
      setSearchQuery(null);
      setUserScroll(0);
      return;
    }

    // Esc closes inline help.
    if (key.escape && helpMessage) {
      setHelpMessage(null);
      return;
    }

    // Esc closes the slash palette.
    if (key.escape && inputText.startsWith('/')) {
      setInputText('');
      setInputResetKey((prev) => prev + 1);
      commandIndexRef.current = 0;
      setCommandIndex(0);
      return;
    }

    if (key.escape && loading && abortControllerRef.current) {
      // Abort the current completion
      abortControllerRef.current.abort();
    }
  });

  // Slash-palette navigation lives in its own ref-based handler. A single
  // dedicated listener avoids the prompt-history path consuming Up/Down, and
  // the refs keep it correct even when Ink delivers an older prop closure.
  useInput((_input, key) => {
    const count = commandItemsRef.current.length;
    if (inputTextRef.current.startsWith('/') && count > 0) {
      if (key.upArrow) {
        setCommandIndex((index) => {
          const next = (index - 1 + count) % count;
          commandIndexRef.current = next;
          return next;
        });
      } else if (key.downArrow) {
        setCommandIndex((index) => {
          const next = (index + 1) % count;
          commandIndexRef.current = next;
          return next;
        });
      }
      return;
    }
    if (!key.upArrow && !key.downArrow) return;
    // A grown composer owns the arrows for caret movement; history only walks
    // on a single-row draft, exactly like the previous PromptInput behaviour.
    if (composerRowsRef.current > 1 && !key.shift) return;
    const nav = historyNavigatorRef.current;
    if (!nav) return;
    if (key.upArrow) {
      if (nav.position === -1) nav.rememberDraft(inputTextRef.current);
      const previous = nav.up();
      if (previous !== null) {
        setInputText(previous);
        setInputResetKey((value) => value + 1);
      } else {
        scrollBy(key.shift ? 3 : 1);
      }
    } else {
      const next = nav.down();
      if (next !== null) {
        setInputText(next);
        setInputResetKey((value) => value + 1);
      } else {
        scrollBy(-(key.shift ? 3 : 1));
      }
    }
  });

  // Fresh filter results start at the first row.
  // Reset the palette cursor synchronously with typing. An effect would run
  // after a following arrow key and silently undo the selection change.

  const chosenVariant = VARIANTS.find((item) => item.id === variantId) ?? VARIANTS[0];
  const remoteModelLabel = config
    ? remoteModels[config.provider]?.find((item) => item.id === config.model)?.label
    : undefined;
  const providerLabel = config ? getProvider(config.provider)?.name ?? config.provider : '';
  const modelLabel = config
    ? `${providerLabel} / ${remoteModelLabel ?? getModelDetails(config.provider, config.model)?.name ?? config.model}`
    : 'not configured';
  const folderName = basename(process.cwd());

  // Footer location: `~/folder:branch`. Read once on mount; a failed git
  // lookup simply leaves the branch suffix off.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  // Left clicks in the composer move the caret; the nonce forces PromptInput
  // to re-apply repeated clicks on the same column.
  const [caretRequest, setCaretRequest] = useState<{ col: number; nonce: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readGitBranch(process.cwd()).then((branch) => {
      if (!cancelled) setGitBranch(branch);
    });
    return () => { cancelled = true; };
  }, []);
  // Any interactive prompt owns the live area. Optional panels are hidden so
  // the critical prompt keeps its rows instead of being clipped at the bottom.
  const hasCriticalPrompt = pendingApproval !== null || pendingAsk !== null || keyPrompt !== null;
  // The update hint is purely informational: hide it whenever a picker,
  // settings, help or a critical prompt owns the live area so it never
  // competes with UI that needs the user's attention.
  const showUpdateNotice =
    Boolean(updateNotice) &&
    !hasCriticalPrompt &&
    !toast &&
    picker === null &&
    settingsIndex === null &&
    helpMessage === null;
  const showSplash =
    initialized &&
    config !== null &&
    !loading &&
    !isStreaming &&
    rows >= 8 &&
    staticItems.length === 0 &&
    !hasConversationMessages(completionMessages);
  const inputFocused =
    initialized && picker === null && settingsIndex === null && keyPrompt === null;

  const dialogInner = dialogInnerWidth(columns);
  const compactDialog = rows <= 10;
  const approvalRequest = pendingApproval
    ? (() => {
        const request = pendingApproval.request;
        const path = extractPathFromArgs(lastToolCallRef.current?.args);
        if (!path || request.detail?.includes(path)) return request;
        return {
          ...request,
          detail: [request.detail, `File: ${path}`].filter(Boolean).join('\n'),
        };
      })()
    : null;
  const modelEmptyMessage = modelsLoading
    ? `Loading models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
    : modelSearch.trim()
      ? `No models match "${modelSearch}".`
      : modelNotice ?? 'No models available.';

  const dialog: React.ReactNode = subagentDetail ? (
    <SubAgentDetail
      record={subagentDetail}
      columns={columns}
      height={Math.max(8, rows - 2)}
      onBack={() => setSubagentDetail(null)}
    />
  ) : pendingApproval && approvalRequest ? (
    <Dialog
      title="Approval required"
      badge={pendingApproval.request.type.replace(/_/g, ' ')}
      hint="↑↓ move · enter confirm · 1/2/3 pick · esc reject"
      columns={columns}
      compact={compactDialog}
    >
      <ApprovalPrompt
        request={approvalRequest}
        columns={compactDialog ? columns : dialogInner + 2}
        compact={dense || compactDialog}
        rows={rows}
        embedded
        onRespond={(response) => settleApproval(response)}
      />
    </Dialog>
  ) : pendingAsk ? (
    <Dialog
      title="Agent question"
      badge={pendingAsk.request.questions.length > 1
        ? `${pendingAsk.request.questions.length} questions`
        : undefined}
      hint={(() => {
        const question = pendingAsk.request.questions[0];
        return askPromptHint({
          typing: false,
          hasOptions: Boolean(question?.options?.length),
          canType: question?.allow_free_text !== false,
          multiple: Boolean(question?.multiple),
        });
      })()}
      columns={columns}
      compact={compactDialog}
    >
      <AskPrompt
        questions={pendingAsk.request.questions}
        columns={compactDialog ? columns : dialogInner + 4}
        compact={dense || compactDialog}
        embedded
        onRespond={(response) => settleAsk(response)}
      />
    </Dialog>
  ) : keyPrompt ? (
    <Dialog
      title="API key"
      badge={keyPrompt.providerName}
      hint={keyPrompt.busy ? 'Checking key and fetching models…' : 'enter save · esc cancel'}
      columns={columns}
      compact={compactDialog}
    >
      <ApiKeyPrompt
        providerName={keyPrompt.providerName}
        path={keyPrompt.path}
        error={keyPrompt.error}
        busy={keyPrompt.busy}
        columns={compactDialog ? columns : dialogInner + 4}
        compact={dense || compactDialog}
        embedded
        onSubmit={(value) => { void handleApiKeySubmit(value); }}
      />
    </Dialog>
  ) : settingsIndex !== null ? (
    <Dialog
      title="Settings"
      badge={`${settingsIndex + 1}/${settingItems.length}`}
      hint="↑↓ move · enter toggle/open · esc close"
      columns={columns}
      compact={compactDialog}
    >
      <DialogList items={settingItems} selected={settingsIndex} maxVisible={paletteWindow} compact={compactDialog} />
    </Dialog>
  ) : picker === 'theme' ? (
    <Dialog
      title="Theme"
      accentGlyph="◈"
      borderStyle="square"
      badge={`${clampIndex(pickerIndex, themeItems.length) + 1}/${themeItems.length}`}
      hint={`↑↓ move · enter use · 1-${THEME_NAMES.length} pick · esc close`}
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={themeItems}
        selected={clampIndex(pickerIndex, themeItems.length)}
        maxVisible={paletteWindow}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'model' ? (
    <Dialog
      title="Select model"
      accentGlyph="◇"
      badge={modelProvider ? modelProvider.name : undefined}
      hint="type to search · ↑↓ move · enter use · esc cancel"
      columns={columns}
      compact={compactDialog}
    >
      <Box flexDirection="row" overflow="hidden">
        <Text color={theme.dim}>search  </Text>
        <Box flexShrink={1} minWidth={1}>
          <Text color={theme.text} wrap="truncate-end">
            {modelSearch}
            <Text inverse>{' '}</Text>
          </Text>
        </Box>
        <Text color={theme.dim}>{`  ${modelItems.length}`}</Text>
      </Box>
      {(modelsLoading || modelNotice) && (
        <Text color={theme.dim} wrap="truncate-end">
          {modelsLoading
            ? `Fetching models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
            : modelNotice}
        </Text>
      )}
      <DialogList
        items={modelItems}
        selected={selectedModelIndex}
        maxVisible={paletteWindow}
        empty={modelEmptyMessage}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'provider' ? (
    <Dialog
      title="Select provider"
      accentGlyph="◇"
      badge={`${providerItems.length} available`}
      hint="↑↓ move · enter use · esc cancel"
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={providerItems}
        selected={clampIndex(pickerIndex, providerItems.length)}
        maxVisible={paletteWindow}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'session' ? (
    <Dialog
      title={pendingSessionDelete ? 'Delete session?' : 'Select session'}
      badge={pendingSessionDelete?.label}
      hint={pendingSessionDelete
        ? 'y delete permanently · n cancel'
        : '↑↓ move · enter resume · d delete · esc close'}
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={sessionItems}
        selected={clampIndex(pickerIndex, sessionItems.length)}
        maxVisible={paletteWindow}
        empty={sessionsLoading ? 'Loading sessions…' : 'No saved sessions. Press esc to close.'}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'subagents' ? (
    <Dialog
      title="Sub-agents"
      badge={`${subagentItems.length} run${subagentItems.length === 1 ? '' : 's'}`}
      hint="↑↓ move · enter inspect · click a row · esc close"
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={subagentItems}
        selected={clampIndex(pickerIndex, subagentItems.length)}
        maxVisible={paletteWindow}
        empty={subagentLoading ? 'Loading sub-agent runs…' : 'No sub-agent runs yet. Delegate a task with sub_agent first.'}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'variant' ? (
    <Dialog
      title="Reasoning variant"
      badge={`${variantItems.length} options`}
      hint="↑↓ move · enter use · esc cancel"
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={variantItems}
        selected={clampIndex(pickerIndex, variantItems.length)}
        maxVisible={paletteWindow}
        compact={compactDialog}
      />
    </Dialog>
  ) : picker === 'statusLine' ? (
    <Dialog
      title="Status line"
      badge={`${(settings.statusLine ?? STATUS_LINE_ITEMS).length}/${STATUS_LINE_ITEMS.length} shown`}
      hint="↑↓ move · enter toggle · esc back"
      columns={columns}
      compact={compactDialog}
    >
      <DialogList
        items={statusLineItems}
        selected={clampIndex(pickerIndex, statusLineItems.length)}
        maxVisible={paletteWindow}
        compact={compactDialog}
      />
    </Dialog>
  ) : null;

  // Rail geometry. `viewportRows` is measured from the real layout, so the
  // thumb lines up with what is actually on screen.
  // Rail height must match the slice actually scrolled (viewport minus the
  // top breathing row), otherwise the thumb drifts from the visible content.
  const scrollbar = scrollbarGeometry(transcriptRows, windowRows, effectiveUserScroll);
  const railLines = restoringTranscript ? [] : scrollbarLines(scrollbar);

  // A dialog owns the full frame so its card floats on a clean canvas. This
  // can trigger Ink's full-repaint path while navigating, which is acceptable
  // for a modal that is not streaming.
  return (
    <Box
      flexDirection="column"
      height={dialogActive ? rows : frameHeight}
      backgroundColor={theme.bg}
      overflow="hidden"
    >
      {/* Scrollable transcript viewport; the input and footer below stay fixed.
          A dialog removes it entirely so the card floats on a clean canvas. */}
      {!dialogActive && (
      <Box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1} overflow="hidden">
        <Box
          ref={viewportRef}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={1}
          overflow="hidden"
          flexDirection="column"
          backgroundColor={theme.bg}
        >
          {restoringTranscript ? (
            <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
              <Text color={theme.dim}>Restoring session…</Text>
            </Box>
          ) : showSplash ? (
            <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
              {columns >= SPLASH_LINES[0].length ? <Splash /> : null}
            </Box>
          ) : (
            <>
              {/* Breathing room above the first message, so content never butts
                  against the top edge of the screen. */}
              <Box height={TOP_PAD} flexShrink={0} />
              {visibleItems.map((item, index) =>
                index === 0 && trimTop > 0 ? (
                  // First item is partly above the viewport. Trim its top rows
                  // by shifting it up inside a clipped, fixed-height box. A
                  // blank spacer here shows empty rows and shoves the item's
                  // bottom off-screen. The wrapper is registered for clicks so
                  // the yoga lookup still sees the clipped geometry.
                  <Box
                    key={item.id}
                    ref={(node) => registerEntryNode(item.id, node)}
                    height={Math.max(1, (visibleRowItems[0]?.rows ?? 1) - trimTop)}
                    overflow="hidden"
                    flexShrink={0}
                  >
                    <Box marginTop={-trimTop} flexShrink={0}>
                      <StaticEntry item={item} columns={columns} onMeasure={handleMeasureItem} />
                    </Box>
                  </Box>
                ) : (
                  <StaticEntry
                    key={item.id}
                    item={item}
                    columns={columns}
                    onMeasure={handleMeasureItem}
                    onRef={registerEntryNode}
                  />
                )
              )}
              {/* Solid bottom: blank rows keep the viewport exactly its
                  measured height, so a shorter frame can never leave rows of
                  the previous one visible under the composer. */}
              {fillerRows > 0 && <Box height={fillerRows} flexShrink={0} />}
            </>
          )}
          {/* Off-screen measurement pass. Absolute positioning plus a clipped
              zero-height parent gives every replayed item its real height
              without painting it, so the first visible frame uses exact rows. */}
          {measuringTranscript && unmeasuredItems.length > 0 && (
            <Box height={0} overflow="hidden" position="relative" width="100%" flexShrink={0}>
              <Box position="absolute" width="100%" flexDirection="column">
                {unmeasuredItems.map((item) => (
                  <StaticEntry
                    key={`measure-${item.id}`}
                    item={item}
                    columns={columns}
                    onMeasure={handleMeasureItem}
                  />
                ))}
              </Box>
            </Box>
          )}
        </Box>

        {/* Scrollbar rail: one column, fixed to the right edge of the viewport
            so it does not scroll with the transcript. */}
        {railLines.length > 0 && (
          <Box flexDirection="column" flexShrink={0} width={1} overflow="hidden">
            {railLines.map((line, index) => (
              <Text
                key={index}
                color={line === SCROLLBAR_THUMB ? theme.muted : theme.border}
              >
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      )}

      {/* Live area: only these rows re-render while typing. A dialog owns the
          whole area and floats centred on the canvas. On short terminals it
          top-aligns, otherwise centring would clip the title off the top. */}
      <Box
        flexDirection="column"
        width="100%"
        backgroundColor={theme.bg}
        flexGrow={dialogActive ? 1 : 0}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        alignItems={dialogActive ? 'center' : undefined}
        justifyContent={dialogActive ? (rows >= 14 ? 'center' : 'flex-start') : undefined}
      >
        {dialogActive ? dialog : (
          <>
        {showUpdateNotice && (
          <Box height={1} flexShrink={0} paddingX={dense ? 0 : gutter} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color={theme.info}>⬆ </Text>
              <Text color={theme.muted}>{updateNotice}</Text>
            </Text>
          </Box>
        )}
        {mode === 'plan' && !hasCriticalPrompt && (
          <Box height={1} flexShrink={0} paddingX={dense ? 0 : gutter} overflow="hidden">
            <Text color={theme.info} bold wrap="truncate-end">
              {`PLAN MODE`}
              <Text color={theme.dim}>{` · Tab for build · no file changes`}</Text>
            </Text>
          </Box>
        )}
        {searchQuery !== null && !hasCriticalPrompt && (
          <Box height={1} flexShrink={0} paddingX={dense ? 0 : gutter} overflow="hidden">
            <Text color={theme.accent} wrap="truncate-end">
              {`${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'} for "${searchQuery}" · Esc clear`}
            </Text>
          </Box>
        )}
        {toast && !hasCriticalPrompt && !searchQuery && (
          <Box height={1} flexShrink={0} paddingX={dense ? 0 : gutter} overflow="hidden">
            <Text color={theme.success} wrap="truncate-end">{toast}</Text>
          </Box>
        )}
        {helpMessage && !dense && !hasCriticalPrompt && (
          <Box paddingX={2}>
            <LeftBar color={theme.muted} marginTop={1} marginBottom={1}>
              <Text wrap="truncate-end">{helpMessage}</Text>
            </LeftBar>
          </Box>
        )}
        {!initialized && !error && <Text color={theme.dim}>Initializing...</Text>}
        {initialized && !config && !hasCriticalPrompt && (
          <Box paddingX={gutter}>
            <Text color={theme.info} wrap="truncate-end">{SETUP_HINT}</Text>
          </Box>
        )}

        {initialized && !hasCriticalPrompt && (
          <TodoPanel todos={todos} columns={columns} maxVisible={visibleTodos} />
        )}

        {showSubAgentPanel && !hasCriticalPrompt && (
          <SubAgentActivity activities={subAgentActivities} columns={columns} />
        )}

        {!hasCriticalPrompt && threadErrors.filter((threadError) => threadError.transient).map((threadError) => (
          <Box key={`thread-error-${threadError.id}`} paddingX={2}>
            <LeftBar color={theme.muted} marginBottom={1}>
              <Text color={theme.muted}>{threadError.message}</Text>
            </LeftBar>
          </Box>
        ))}

          </>
        )}
        {!picker && !keyPrompt && settingsIndex === null && initialized && !hasCriticalPrompt && inputText.startsWith('/') && (
          <Palette
            items={commandItems}
            selected={commandIndex}
            maxVisible={paletteWindow}
            query={inputText.trim()}
            columns={columns}
            hint="↑↓ move · tab complete · enter run · esc close"
          />
        )}
      </Box>

      {/* F12 details panel: compact dim log box, never a modal, never throws
          when logging is disabled (getRecentLogs returns an empty buffer). */}
      {showErrorPanel && !dialogActive && (
        <Box
          flexDirection="column"
          width="100%"
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
          flexShrink={0}
          overflow="hidden"
        >
          <Text color={theme.dim} bold wrap="truncate-end">{`Recent logs · F12 close`}</Text>
          {errorLines.length === 0
            ? <Text color={theme.dim} wrap="truncate-end">No log entries yet.</Text>
            : errorLines.map((line, index) => (
                <Text key={index} color={theme.dim} wrap="truncate-end">{line}</Text>
              ))}
        </Box>
      )}

      {/* `?` shortcut sheet, directly above the hint strip. */}
      {shortcutLines.length > 0 && (
        <Box
          flexDirection="column"
          width="100%"
          paddingX={dense ? 0 : gutter}
          marginBottom={1}
          flexShrink={0}
          overflow="hidden"
        >
          {shortcutLines.map((line, index) => (
            <Text key={index} color={theme.dim} wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )}

      {/* Contextual one-line hint strip, directly above the composer. */}
      {hintRows > 0 && (
        <Box height={1} width="100%" flexShrink={0} paddingX={dense ? 0 : gutter} overflow="hidden">
          <Text color={theme.dim} wrap="truncate-end">{hintLine}</Text>
        </Box>
      )}

      {/* Composer: a borderless text area with one blue accent bar on the
          left. The old full box drew a bright outline around every keystroke;
          a single edge keeps the focus cue without boxing the text in.
          The gaps above and inside give the input room to breathe. */}
      {initialized && !dialogActive && (
        <Box
          flexDirection="column"
          width="100%"
          backgroundColor={theme.bg}
          alignItems="center"
          flexShrink={0}
          overflow="hidden"
        >
          {busy && !hasCriticalPrompt ? (
            <Box width={layout.inputWidth} backgroundColor={theme.bg} flexShrink={0}>
              <LiveStatus
                columns={layout.inputWidth}
                activity={liveActivity}
                tool={activeTool}
                elapsedMs={busyElapsedMs}
                tps={decodeTps}
                frame={spinnerFrame}
                animate={animationsEnabled}
                gutter={1}
              />
            </Box>
          ) : null}
          <Box
            flexDirection="row"
            width={layout.inputWidth}
            backgroundColor={theme.surface}
            paddingY={dense ? 0 : 1}
            paddingLeft={1}
            flexShrink={0}
          >
            <Box
              borderStyle="bold"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              borderLeftColor={inputFocused ? theme.accent : theme.border}
              paddingRight={1}
              height={composerRows}
              flexShrink={0}
            />
            <Box flexGrow={1} minWidth={1} paddingRight={2} height={composerRows} overflow="hidden">
              <PromptInput
                key={inputResetKey}
                value={inputText}
                onChange={(value) => {
                  // The `?` key toggles the shortcut sheet; ignore PromptInput's
                  // copy of that keystroke so it is not inserted twice.
                  if (shortcutGuardRef.current) {
                    shortcutGuardRef.current = false;
                    return;
                  }
                  setInputText(value);
                  commandIndexRef.current = 0;
                  setCommandIndex(0);
                  if (value) setShowShortcuts(false);
                }}
                onSubmit={submitSafely}
                isDisabled={picker !== null || settingsIndex !== null || keyPrompt !== null}
                placeholder="Build anything…  (shift+enter newline · @file · /commands)"
                width={composerWidth}
                maxRows={composerMaxRows}
                onRowsChange={setComposerRows}
                caretRequest={caretRequest ?? undefined}
                onPaste={async (text) => {
                  const summary = await summarizePaste(text, { label: session?.id ?? 'paste' });
                  return summary.text;
                }}
                onMentionCandidates={provideMentionCandidates}
                onCompleteMention={async (value, cursor) => {
                  const mention = findMentionToken(value, cursor);
                  if (!mention) return null;
                  const matches = await listMentionCandidates(process.cwd(), mention.token, 20);
                  if (matches.length === 0) return null;
                  // Only a unique match closes the token with a space; a
                  // common-prefix completion is still being typed.
                  const replacement = matches.length === 1
                    ? `${matches[0]} `
                    : commonPrefix(matches);
                  const applied = applyMention(value, mention, replacement);
                  return { value: applied.text, cursor: applied.cursor };
                }}
              />
            </Box>
            {layout.showSubmitHint && (
              <Box paddingRight={1} height={composerRows} flexShrink={0} alignItems="flex-end">
                <Text color={theme.dim}>{'↵'}</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Status: folder · model · variant · context — hidden while a dialog
          owns the screen so the card keeps every available row. */}
      {initialized && !dialogActive && (
        <UsageDisplay
          usage={lastUsage ?? null}
          totalCost={totalCost}
          modelLabel={modelLabel}
          variantLabel={chosenVariant.label}
          variantColor={chosenVariant.color}
          tps={decodeTps}
          folder={folderName}
          branch={gitBranch}
          contextTokens={lastUsage?.contextTokens}
          contextWindow={lastUsage?.contextWindow ?? getModelPaletteInfo(config?.provider ?? '', config?.model ?? '')?.contextWindow}
          busy={false}
          tool={null}
          frame={spinnerFrame}
          compact={!layout.showFullFooter}
          gutter={gutter}
          dense={dense}
          segments={settings.statusLine ?? STATUS_LINE_ITEMS}
        />
      )}
    </Box>
  );
};

/**
 * Owns the UI settings so the selected palette can be published to the whole
 * tree. Cycling the Theme row calls setSettings, which updates `name` here and
 * makes ThemeProvider hand every consumer a fresh, immutable palette.
 */
export const App: React.FC<AppProps> = (props) => {
  const [settings, setSettings] = useState<UiSettings>(loadSettings);
  // Register user palettes before ThemeProvider resolves the palette. Without
  // this, a saved `custom` theme kept the placeholder colour until some later
  // state change forced a new ThemeProvider name (useMemo is keyed on name).
  registerUserThemes(settings.themePath);
  return (
    // Remount when themePath changes so the provider recomputes its palette
    // even though the selected name (`custom`) did not change.
    <ThemeProvider key={settings.themePath ?? ''} name={settings.theme}>
      <AppContent {...props} settings={settings} setSettings={setSettings} />
    </ThemeProvider>
  );
};

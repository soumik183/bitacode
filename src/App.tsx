/**
Main UI component — the heart of Bitacode's terminal interface.

Renders the chat loop, tool call feedback, approval prompts,
and cost/usage info. All heavy logic lives in `agentic-loop.ts`;
this file is purely presentation + state wiring.

ACTUAL UI Layout:
┌─────────────────────────────────────────┐
│  Bitacode wordmark (centered hero, empty conversation only)
│  Model: Provider / model | Session: id  │  static header
│  Debug logs: /path/to/log               │  static, if --log-level set
│  Config file: /path/to/config           │  static, if config exists
│  MCPs: server1, server2                 │  static, if MCPs connected
├─────────────────────────────────────────┤
│                                         │
│  Archived messages (Static scrollback): │
│  > user message                         │
│  assistant reply text                   │
│  ▶ tool_name: result preview...         │
│                                         │
├ ─ ─ ─ ─ ─ live boundary ─ ─ ─ ─ ─ ─ ─ ─ ┤
│                                         │
│  assistant streaming text...▍           │  live (re-renders per token)
│                                         │
│  ⠹ Running read_file...                 │  live, spinner + active tool
│                                         │
│ ╭─ Approval Required ─────────────────╮ │  live, when pending approval
│ │  description / detail               │ │
│ │  ○ Approve once                     │ │
│ │  ○ Approve for session              │ │
│ │  ○ Reject                           │ │
│ ╰─────────────────────────────────────╯ │
│                                         │
│  [Error: message]                       │  live, inline thread errors
│                                         │
├─────────────────────────────────────────┤
│  tokens: 1234↓ 56↑ | ctx: 12% | $0.02   │  live, updates each turn
├─────────────────────────────────────────┤
│  /quit  — Exit Bitacode               │  dynamic, shown when typing / to show available commands
├─────────────────────────────────────────┤
│  ⠹ Running read_file...                 │  dynamic, shown while loading
├─────────────────────────────────────────┤
│ ╭─────────────────────────────────────╮ │
│ │ > [text input cursor              ] │ │  always visible when initialized
│ ╰─────────────────────────────────────╯ │
├─────────────────────────────────────────┤
│  Session saved. Resume with:            │  one-shot, shown on /quit
│  bitacode --session abc12345          │
└─────────────────────────────────────────┘

NOTES:
- System prompt is NOT displayed (filtered out in replay)
- Tool results are flat text, not collapsible
- "Working..." spinner shown when loading but not streaming
*/

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout, measureElement } from 'ink';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { LeftBar } from './components/LeftBar.js';
import { Palette, SLASH_COMMANDS, type PaletteItem } from './components/Palette.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { AskPrompt } from './components/AskPrompt.js';
import { ApiKeyPrompt } from './components/ApiKeyPrompt.js';
import { EntryErrorBoundary } from './components/EntryErrorBoundary.js';
import { UsageDisplay } from './components/UsageDisplay.js';
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
import { theme, getTheme, THEME_NAMES } from './theme.js';
import {
  loadSettings,
  saveSettings,
  STATUS_LINE_ITEMS,
  type UiSettings,
  type ApprovalMode,
} from './settings.js';
import { VARIANTS } from './variants.js';
import { PromptInput } from './components/PromptInput.js';
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
  recordSubAgentStatus,
  handleToolCall,
  setPlanMode,
} from './tools/index.js';
import type { ApprovalRequest, ApprovalResponse } from './utils/approval.js';
import type { AskRequest, AskResponse } from './tools/ask.js';
import { setLogLevel, LogLevel, initLogFile, logger } from './utils/logger.js';
import {
  createSession,
  deleteSession,
  ensureSystemPromptAtTop,
  hasConversationMessages,
  saveSession,
  loadSession,
  listSessions,
  generateTitle,
  type Session,
  type SubAgentActivity as SubAgentActivityData,
} from './sessions.js';
import { clearTodos, getTodosForSession, setTodosForSession, type TodoItem } from './tools/todo.js';
import { initializeMcp, closeMcp } from './mcp.js';
import { generateSystemPrompt } from './system-prompt.js';
import { renderFormattedText, normalizeTranscriptText } from './utils/format-message.js';
import { formatContextWindow, listProviderModels } from './utils/provider-models.js';
import { addToolResultView } from './utils/tool-result-view.js';
import { itemAtViewportRow, type AddStaticFn } from './utils/transcript.js';
import { getLeftMousePress, getWheelDelta, isClickOnThinkingBlock, isMouseReport, stripMouseReports } from './utils/mouse.js';
import { nextThinkingExpansion } from './utils/thinking-expansion.js';
import {
  clampScroll,
  maxScrollOffset,
  scrollAfterGrowth,
  sliceItemsToWindow,
  visibleRowWindow,
} from './utils/scroll.js';
import { clampIndex, composerTextWidth, finiteDim, frameRows, resolveLayout, splitLiveArea } from './utils/layout.js';
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

// Keep scrollback rendering light on long sessions and low-memory devices.
const MAX_STATIC_ITEMS = 120;
// Resumed sessions keep their full model context, but replay only the tail to
// scrollback so a huge transcript does not flood the terminal at once.
const MAX_REPLAY_MESSAGES = 100;
// Avoid refetching a provider's model list on every /model open.
const MODEL_CACHE_TTL_MS = 5 * 60_000;

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
  onMeasure: (id: string, rows: number) => void;
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
    if (height > 0) onMeasure(item.id, height);
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

const Splash: React.FC = () => (
  <Box flexDirection="column" alignItems="center">
    <Text color={theme.text} bold>
      {SPLASH_LINES.join('\n')}
    </Text>
  </Box>
);

// First-run guidance lives in the main screen, never in a blocking wizard.
const SETUP_HINT = 'No provider configured — type /provider to choose one';
const API_MISSING_HINT = 'API key missing — type /provider to select a provider and add a key.';

function printMessageToScrollback(addStatic: AddStaticFn, role: 'user' | 'assistant', text: string): void {
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
          borderLeftColor={theme.userBorder}
          paddingLeft={1}
        >
          <Text color={theme.userText}>{normalized}</Text>
        </Box>
      </Box>
    );
    return;
  }
  // Fallback is assistant, render with Markdown formatting (bold, italic)
  addStatic(
    <Box paddingX={2} paddingBottom={1}>
      <Text>{renderFormattedText(normalized)}</Text>
    </Box>
  );
}

function replayOneMessage(
  addStatic: AddStaticFn,
  message: Message,
  toolCallsById: Map<string, { name: string; args?: string | Record<string, unknown> }>,
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
    printMessageToScrollback(addStatic, 'user', message.content);
    return;
  }
  if (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  ) {
    printMessageToScrollback(addStatic, 'assistant', message.content);
    return;
  }
  if (message.role === 'tool') {
    const savedCall = msgAny.tool_call_id ? toolCallsById.get(msgAny.tool_call_id) : undefined;
    const toolName = typeof msgAny.name === 'string' && msgAny.name ? msgAny.name : savedCall?.name || 'tool';
    const toolArgs = msgAny.args ?? savedCall?.args;
    addToolResultView(addStatic, toolName, toolArgs, String(msgAny.content || ''));
  }
}

function replayMessagesToScrollback(
  addStatic: AddStaticFn,
  messages: Message[],
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
        <Text color={theme.dim}>
          … {omitted} earlier message{omitted === 1 ? '' : 's'} kept in model context, not replayed …
        </Text>
      </Box>
    );
  }
  for (const message of visible) {
    try {
      replayOneMessage(addStatic, message, toolCallsById, columns);
    } catch (err: any) {
      // One malformed saved message must not abort the rest of the transcript.
      logger.warn('Skipped malformed session message during replay', {
        error: err?.message ?? String(err),
        role: (message as any)?.role,
      });
      addStatic(
        <Box paddingX={2} marginBottom={1}>
          <Text color={theme.dim}>… one saved message could not be displayed …</Text>
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
  activities: SubAgentActivityData[]
): void {
  if (activities.length === 0) return;
  addStatic(
    <Box paddingX={2} marginBottom={1}>
      <Text color={theme.muted}>{`▣ ${subAgentActivitySummary(activities)}`}</Text>
    </Box>
  );
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
    const lineRows = Math.max(1, Math.ceil(Array.from(lines[index]).length / width));
    if (rows + lineRows > budget) break;
    rows += lineRows;
    kept.unshift(lines[index]);
  }
  return (kept.length > 0 ? kept : [lines[lines.length - 1] ?? '']).join('\n');
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
}

// ─── Help text derived from slash commands ───
// Shortcuts accept ctrl OR alt (Ink reports Alt via `key.meta`). Text-editing
// keys a/e/u/w belong to PromptInput, so they are deliberately absent here.
const APPROVAL_MODES: ApprovalMode[] = ['manual', 'auto', 'yolo'];

function buildHelpText(approvalMode: ApprovalMode): string {
  // Keep the panel compact: the live area is height-capped so the composer and
  // footer can never be pushed off screen.
  const commands = SLASH_COMMANDS.map((cmd) => cmd.name).join(' ');
  return [
    'Commands:',
    `  ${commands}`,
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

function buildClient(config: Config, apiKeyOverride?: string): OpenAI {
  const provider = getProvider(config.provider);
  const apiKey = apiKeyOverride?.trim() || resolveApiKey(config);

  if (!apiKey) {
    const providerName = provider?.name || config.provider;
    const envVar = provider?.apiKeyEnvVar;
    throw new Error(
      envVar
        ? `Missing API key for ${providerName}. Set it in config or export ${envVar}.`
        : `Missing API key for ${providerName}.`
    );
  }

  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey,
  };

  // baseURL: env var override takes precedence over provider default
  const baseURLOverride = process.env.BITACODE_BASE_URL?.trim();
  const baseURL = baseURLOverride || provider?.baseURL;
  if (baseURL) {
    clientOptions.baseURL = baseURL;
  }

  // Custom headers: env override takes precedence over provider defaults
  const rawHeaders = process.env.BITACODE_CUSTOM_HEADERS?.trim();
  if (rawHeaders) {
    const defaultHeaders: Record<string, string> = {};
    for (const line of rawHeaders.split('\n')) {
      const sep = line.indexOf(': ');
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 2).trim();
      if (key && value) defaultHeaders[key] = value;
    }
    if (Object.keys(defaultHeaders).length > 0) {
      clientOptions.defaultHeaders = defaultHeaders;
    }
  } else if (provider?.headers && Object.keys(provider.headers).length > 0) {
    clientOptions.defaultHeaders = provider.headers;
  }

  return new OpenAI(clientOptions);
}

interface ApiKeyRequest {
  providerId: string;
  providerName: string;
  path: string;
  error: string | null;
  busy: boolean;
}

// ─── Main App ───
export const App: React.FC<AppProps> = ({
  dangerouslySkipPermissions = false,
  logLevel,
  sessionId,
  updateNotice,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // A zoom burst can briefly report 0/undefined/NaN dimensions; clamp once at
  // the source so every downstream width/height stays a finite positive int.
  const [dims, setDims] = useState({
    columns: finiteDim(stdout?.columns, 80),
    rows: finiteDim(stdout?.rows, 24),
  });
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
  const handleMeasureItem = useCallback((id: string, rows: number) => {
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
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
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
  // Live one-line hint/toast (retry, copy, background task completion, …).
  const [toast, setToast] = useState<string | null>(null);
  const toastActiveRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastToastAtRef = useRef(0);
  // /find filters scrollback by the text extracted from each card.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  // Last submitted user text, used by Ctrl+R (retry) and Alt+Up (edit).
  const lastSubmitRef = useRef<string | null>(null);
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

  // User-facing preferences + live reasoning/todo state
  const [settings, setSettings] = useState<UiSettings>(loadSettings);
  // Every component imports the same mutable `theme` palette object, so
  // retheming in place is the smallest way to apply a choice across the UI.
  Object.assign(theme, getTheme(settings.theme));
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
  const [showSubAgentPanel, setShowSubAgentPanel] = useState(false);

  // Input reset key — incremented on submit to force TextInput remount and clear
  const [inputResetKey, setInputResetKey] = useState(0);

  // Palette state: slash-command list, provider/model/variant pickers
  const [commandIndex, setCommandIndex] = useState(0);
  const [picker, setPicker] = useState<'model' | 'variant' | 'provider' | 'session' | 'statusLine' | null>(null);
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

  // Approval state
  const [pendingAsk, setPendingAsk] = useState<{
    request: AskRequest;
    resolve: (response: AskResponse) => void;
  } | null>(null);

  const [pendingApproval, setPendingApproval] = useState<{
    request: ApprovalRequest;
    resolve: (response: ApprovalResponse) => void;
  } | null>(null);

  // Usage state
  const [lastUsage, setLastUsage] = useState<AgentEvent['usage'] | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Active tool tracking — shows which tool is currently executing
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Session state
  const [session, setSession] = useState<Session | null>(null);

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
  const assistantMessageRef = useRef<AssistantMessageRef | null>(null);
  // Latest reasoning for the current turn; refs survive stale loop closures.
  const reasoningRef = useRef('');

  // Abort controller for cancelling the current completion
  const abortControllerRef = useRef<AbortController | null>(null);
  // Monotonic run id. /new bumps it so an older run cannot write its results
  // into the new session after being aborted.
  const activeRunRef = useRef(0);

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
        if (fields.subAgentStatus === 'done' || fields.subAgentTool?.status === 'done') {
          const label = fields.subAgentLabel || fields.subAgentTask || 'Sub-agent';
          showToast(`✓ ${label} finished`);
        }
      }
      if (event.type === 'tool_result' && event.toolCall?.name === 'start_process') {
        showToast('Background process started');
      }
      handleAgentEvent(event);
    },
    [handleAgentEvent, mode, addStatic, showToast]
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
  const printedThreadErrorIdsRef = useRef<Set<string>>(new Set());

  const initializeWithConfig = useCallback(async (loadedConfig: Config) => {
    // The first-run wizard may have just written a new config, so refresh the
    // provider registry before building the client.
    await loadRuntimeConfig(true);
    setConfig(loadedConfig);

    clientRef.current = buildClient(loadedConfig);

    // Initialize MCP servers
    await initializeMcp();

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

        // A resumed session owns the provider/model it was created with.
        let sessionConfig = loadedConfig;
        if (loadedSession.provider && loadedSession.model) {
          try {
            const candidate = {
              provider: loadedSession.provider,
              model: loadedSession.model,
            };
            clientRef.current = buildClient(candidate);
            sessionConfig = candidate;
            try {
              const target =
                getActiveRuntimeConfigPath() === getRuntimeConfigPath('project')
                  ? 'project'
                  : 'user';
              writeActiveSelection(candidate.provider, candidate.model, target);
            } catch (err: any) {
              logger.warn('Could not persist resumed session selection', { error: err.message });
            }
          } catch (err: any) {
            setError(
              `Session model ${loadedSession.provider}/${loadedSession.model} is unavailable: ${err.message}`
            );
          }
        }
        loadedSession.provider = sessionConfig.provider;
        loadedSession.model = sessionConfig.model;
        setConfig(sessionConfig);

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
          replayMessagesToScrollback(addStatic, loadedSession.completionMessages, MAX_REPLAY_MESSAGES, columns);
          replaySubAgentActivities(addStatic, savedActivities);
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
      setSession(newSession);
      didPrintIntroRef.current = true;
    }

    setInitialized(true);
  }, [dangerouslySkipPermissions, sessionId, addStatic, columns]);

  useEffect(() => {
    if (!loading || !settings.animations) {
      setSpinnerFrame(0);
      return;
    }

    // Termux/Android renders slower; fewer frames means less CPU/battery.
    const spinnerIntervalMs = process.platform === 'android' ? 120 : 60;
    const interval = setInterval(() => {
      setSpinnerFrame((prev) => prev + 1);
    }, spinnerIntervalMs);

    return () => clearInterval(interval);
  }, [loading, settings.animations]);

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
    if (error) {
      addStatic(
        <Box paddingX={2}>
          <Text color={theme.error}>Error: {error}</Text>
        </Box>
      );
    }
  }, [error, addStatic]);

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
  }, [threadErrors, addStatic]);

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

  // The alternate screen is entered and cleared by cli.tsx *before* Ink's
  // first render. Doing the raw \x1b[2J\x1b[H here (after commit) desyncs
  // Ink's incremental cursor/line accounting: Ink assumes the cursor is at the
  // bottom of the last frame, but the raw clear homes it to row 0, so later
  // diffs paint rows at the wrong offsets (e.g. a duplicated composer row).
  useEffect(() => {
    if (!stdout) return;
    return () => {
      stdout.write('\x1b[?1006l\x1b[?1000l');
      stdout.write('\x1b]111\x07');
      stdout.write('\x1b[?1049l');
      if (sessionSavedRef.current) {
        stdout.write('\x1b[2m  session saved\x1b[0m\n');
      }
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
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, dims.columns, dims.rows]);

  // The bottom input/footer are fixed; the transcript viewport takes the
  // remaining rows. Measure it so wheel/keyboard scrolling can clamp exactly.
  //
  // The viewport height is derived from the frame minus the live panels, so it
  // only needs re-measuring when one of those changes size. Measuring on every
  // render (the previous behaviour) fired a state update per keystroke and per
  // spinner tick, which reflowed the whole tree and made scrolling stutter.
  const liveAreaSignature = [
    rows,
    columns,
    todos.length,
    thinkingText.length,
    thinkingExpanded,
    streamingText.length,
    helpMessage ? helpMessage.length : 0,
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
    searchQuery?.length ?? 0,
  ].join(':');

  useEffect(() => {
    if (!viewportRef.current) return;
    const height = measureElement(viewportRef.current).height;
    if (height > 0 && height !== viewportRows) {
      setViewportRows(height);
    }
  }, [liveAreaSignature]);

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
        return new Promise((resolve) => {
          setPendingApproval({ request: req, resolve });
        });
      });

      // The agent can pause to ask the user a question; the UI owns the
      // interaction and resolves the promise with the collected answers.
      setAskHandler(async (req: AskRequest): Promise<AskResponse> => {
        return new Promise((resolve) => {
          setPendingAsk({ request: req, resolve });
        });
      });

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
      closeMcp();
    };
  }, []);

  // Palette contents. Kept ahead of handleSubmit because Enter runs the highlighted row.
  const commandItems = SLASH_COMMANDS.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(inputText.trim().toLowerCase())
  ).map((cmd) => ({ id: cmd.name, label: cmd.name, description: cmd.description }));

  const providerItems = getAllProviders().map((provider) => {
    const keyReady = resolveApiKey({ provider: provider.id }) !== null;
    const modelCount = remoteModels[provider.id]?.length || provider.models.length;
    return {
      id: provider.id,
      label: provider.name,
      description: `${provider.id} · ${modelCount} model${modelCount === 1 ? '' : 's'}${keyReady ? '' : ' · key needed'}`,
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
  const modelItems: PaletteItem[] = modelSearchTerm
    ? allModelItems.filter(
        (item) =>
          item.label.toLowerCase().includes(modelSearchTerm) ||
          item.id.toLowerCase().includes(modelSearchTerm)
      )
    : allModelItems;
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

  const settingItems = [
    {
      id: 'animations',
      label: 'Animations',
      description: settings.animations ? 'on' : 'off',
    },
    {
      id: 'mouseClicks',
      label: 'Mouse click thinking',
      description: settings.mouseClicks ? 'on' : 'off',
    },
    {
      id: 'approvalMode',
      label: 'Approval mode',
      description: effectiveApprovalMode,
    },
    {
      id: 'theme',
      label: 'Theme',
      description: settings.theme ?? 'dark',
    },
    {
      id: 'statusLine',
      label: 'Status line',
      description: `${(settings.statusLine ?? STATUS_LINE_ITEMS).length}/${STATUS_LINE_ITEMS.length} shown`,
    },
  ];

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
        const current = (THEME_NAMES as readonly string[]).indexOf(settings.theme ?? 'dark');
        const nextName = THEME_NAMES[(current + 1) % THEME_NAMES.length]!;
        const next = { ...settings, theme: nextName };
        setSettings(next);
        saveSettings(next);
        showToast(`Theme: ${nextName}`);
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
    [settings, showToast]
  );

  const statusLineItems: PaletteItem[] = STATUS_LINE_ITEMS.map((id) => ({
    id,
    label: id,
    description: (settings.statusLine ?? STATUS_LINE_ITEMS).includes(id) ? 'on' : 'off',
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
    const details = getModelDetails(providerId, modelId);
    return details ? { name: details.name, contextWindow: details.contextWindow } : undefined;
  }, []);

  const loadModels = useCallback(
    async (providerId: string, client: OpenAI, preferredModelId?: string) => {
      const cached = remoteModelsRef.current[providerId];
      const cachedAt = modelCacheTimeRef.current[providerId] ?? 0;
      if (
        cached?.length &&
        cachedAt > 0 &&
        Date.now() - cachedAt < MODEL_CACHE_TTL_MS
      ) {
        if (!modelSearchRef.current && preferredModelId) {
          const index = cached.findIndex((item) => item.id === preferredModelId);
          if (index >= 0) setPickerIndex(index);
        }
        return;
      }

      const seq = ++modelFetchSeqRef.current;
      setModelsLoading(true);
      setModelNotice(null);

      const result = await listProviderModels(client, providerId);
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

      // Check the key before persisting it so a typo is not saved.
      const result = await listProviderModels(client, prompt.providerId);
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

      // First run straight from /provider: a saved key is already a usable
      // config, so boot into chat with the provider's default model.
      if (!config) {
        const firstModel = getProvider(prompt.providerId)?.models[0]?.id ?? result.items[0]?.id;
        setRemoteModels((prev) => ({ ...prev, [prompt.providerId]: result.items }));
        setKeyPrompt(null);
        if (firstModel) {
          finalizeFirstConfig(prompt.providerId, firstModel, {
            name: result.items[0]?.label,
            contextWindow: result.items[0]?.contextWindow,
          });
        }
        return;
      }

      if (result.items.length > 0) {
        setRemoteModels((prev) => ({ ...prev, [prompt.providerId]: result.items }));
      }
      setKeyPrompt(null);
      setPendingProviderId(prompt.providerId);
      setPicker('model');
      setPickerIndex(0);
      setModelSearch('');
      setModelsLoading(false);
      setModelNotice(
        result.error
          ? `Could not fetch models (${result.error}); using built-in list.`
          : null
      );
    },
    [config, keyPrompt, finalizeFirstConfig]
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
    setPendingAsk(null);
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
  }, []);

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
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const previousSessionId = session?.id ?? null;
    activeRunRef.current += 1;

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
        return {
          id: summary.id,
          label: title || 'Untitled session',
          description: `${modelLabel || 'unknown model'} · ${summary.messageCount} msg${summary.messageCount === 1 ? '' : 's'}${current}`,
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

        // Restore the session's own provider/model when it still has a key.
        const providerId = loaded.provider || config.provider;
        const modelId = loaded.model || config.model;
        let nextConfig = config;
        let modelError: string | null = null;
        try {
          clientRef.current = buildClient({ provider: providerId, model: modelId });
          nextConfig = { provider: providerId, model: modelId };
        } catch (err: any) {
          modelError = err.message;
        }

        const savedVariant = loaded.variant;
        const nextVariant =
          savedVariant && VARIANTS.some((item) => item.id === savedVariant)
            ? savedVariant
            : variantId;

        loaded.provider = nextConfig.provider;
        loaded.model = nextConfig.model;
        loaded.variant = nextVariant;
        loaded.completionMessages = messages;

        setConfig(nextConfig);
        setVariantId(nextVariant);
        if (settings.variant !== nextVariant) {
          const nextSettings = { ...settings, variant: nextVariant };
          setSettings(nextSettings);
          saveSettings(nextSettings);
        }
        if (!modelError) {
          persistActiveSelection(providerId, modelId, getModelPaletteInfo(providerId, modelId));
        }

        setCompletionMessages(messages);
        setSession(loaded);
        setTodosForSession(loaded.id, loaded.todos);
        setTodos(loaded.todos);
        resetLiveState();
        const loadedActivities = loaded.subAgentActivities ?? [];
        setSubAgentActivities(loadedActivities);
        setShowSubAgentPanel(false);

        if (modelError) {
          setError(`Session loaded, but its model is unavailable: ${modelError}`);
        }

        setStaticItems([]);
        setUserScroll(0);
        if (hasConversationMessages(messages)) {
          setMeasuringTranscript(true);
        }
        replayMessagesToScrollback(addStatic, messages, MAX_REPLAY_MESSAGES, columns);
        replaySubAgentActivities(addStatic, loadedActivities);
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
      persistActiveSelection,
      getModelPaletteInfo,
      stdout,
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
      addToolResultView(addStatic, 'bash', JSON.stringify({ command }), result);
    } catch (err: any) {
      setError(`Shell command failed: ${err?.message ?? String(err)}`);
    }
  }, [session?.id, addStatic, showToast]);

  const handleSlashCommand = useCallback(async (cmd: string, raw = cmd): Promise<boolean> => {
    const parts = raw.trim().split(/\s+/);
    const command = cmd.toLowerCase();

    switch (command) {
      case '/quit':
      case '/exit':
        // No active session: exit immediately. Otherwise: save before exit.
        if (!session) {
          exit();
          return true;
        }

        try {
          const nextSession: Session = {
            ...session,
            completionMessages,
            todos: getTodosForSession(session.id),
            title: generateTitle(completionMessages),
            variant: variantId,
            subAgentActivities,
          };

          await saveSession(nextSession);
          setSession(nextSession);
          setError(null);
          sessionSavedRef.current = true;
          exit();
        } catch (err: any) {
          setError(`Failed to save session before exit: ${err.message}`);
        }
        return true;
      case '/help':
        setHelpMessage(buildHelpText(effectiveApprovalMode));
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
      case '/undo': {
        setError(null);
        try {
          const result = await handleToolCall('undo', {}, { sessionId: session?.id });
          addToolResultView(addStatic, 'undo', {}, result);
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
    session,
    completionMessages,
    allModelItems,
    providerItems,
    variantId,
    effectiveApprovalMode,
    loadModels,
    startNewSession,
    switchSession,
    openSessionPicker,
    deleteSavedSession,
    session?.id,
    addStatic,
    showToast,
  ]);

  const applyPicker = useCallback(() => {
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
    modelItems,
    selectedModelIndex,
    providerItems,
    config,
    pendingProviderId,
    settings,
    sessionItems,
    beginProviderSwitch,
    persistActiveSelection,
    switchSession,
    finalizeFirstConfig,
    modelProviderId,
  ]);

  const handleSubmit = useCallback(async (value: string, force = false, keepInput = false) => {
    const trimmed = value.trim();
    if (!trimmed || (loading && !force)) return;

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
      const selected = commandItems[commandIndex]?.label ?? trimmed.split(/\s+/)[0];
      const handled = await handleSlashCommand(selected, trimmed);
      if (handled) {
        if (!keepInput) {
          setInputText('');
          setInputResetKey((prev) => prev + 1);
        }
        return;
      }
    }

    if (!clientRef.current || !config) {
      setError(API_MISSING_HINT);
      return;
    }

    if (!keepInput) {
      setInputText('');
      setInputResetKey((prev) => prev + 1); // Force TextInput to remount and clear
    }
    sessionSavedRef.current = false;
    setSearchQuery(null);
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
    const userText = mode === 'plan' ? `${PLAN_MODE_NOTE}\n\n${trimmed}` : trimmed;
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
    printMessageToScrollback(addStatic, 'user', trimmed);
    setCompletionMessages((prev) =>
      imageMessage ? [...prev, userMessage, imageMessage] : [...prev, userMessage]
    );
    lastSubmitRef.current = trimmed;

    // Reset assistant message tracker (streamed indices were reset above)
    assistantMessageRef.current = null;

    try {
      const pricing = getModelPricing(config.provider, config.model);
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
        trimmed,
        handleAgentEventWithSubAgents,
        {
          pricing: pricing || undefined,
          abortSignal: abortControllerRef.current.signal,
          sessionId: session?.id,
          requestDefaults,
          compactThreshold: settings.compactThreshold,
        }
      );

      // A newer run (or /new) superseded this one: drop the result instead of
      // writing the old conversation into the current session.
      if (runId !== activeRunRef.current) return;

      // Final update to ensure we have the complete message history
      setCompletionMessages(updatedMessages);

      // Update session
      if (session) {
        session.completionMessages = updatedMessages;
        session.todos = getTodosForSession(session.id);
        session.title = generateTitle(updatedMessages);
        session.provider = config.provider;
        session.model = config.model;
        session.variant = variantId;
        session.subAgentActivities = subAgentActivities;
        await saveSession(session);
        sessionSavedRef.current = true;
      }
    } catch (err: any) {
      if (runId !== activeRunRef.current) return;
      setError(err.message);
    } finally {
      if (runId === activeRunRef.current) {
        setLoading(false);
      }
    }
  }, [loading, config, completionMessages, session, handleSlashCommand, addStatic, rows, commandItems, commandIndex, variantId, settings, handleAgentEventWithSubAgents, mode, runShellCommand]);

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

  // /find filters the scrollback view without deleting history.
  const searchMatches = searchQuery
    ? staticItems.filter((item) =>
        nodeText(item.node).toLowerCase().includes(searchQuery.toLowerCase())
      )
    : staticItems;
  const transcriptRows = searchMatches.reduce(
    (total, item) => total + (measuredHeights[item.id] ?? fallbackItemRows(item.node)),
    0
  );
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
  // Map the row window onto measured items. Items below the viewport are
  // skipped entirely, so a long session stays cheap to render.
  const sizedItems = searchMatches.map((item) => ({
    item,
    rows: measuredHeights[item.id] ?? fallbackItemRows(item.node),
  }));
  const windowSlice = sliceItemsToWindow(
    sizedItems.map((entry) => ({ id: entry.item.id, rows: entry.rows })),
    rowWindow.first,
    rowWindow.last
  );
  const visibleIds = new Set(windowSlice.items.map((entry) => entry.id));
  const visibleItems = searchMatches.filter((item) => visibleIds.has(item.id));
  const visibleRowItems = visibleItems.map((item) => ({
    id: item.id,
    rows: measuredHeights[item.id] ?? fallbackItemRows(item.node),
  }));
  const trimTop = windowSlice.trimTop;

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
      exit();
      return;
    }

    // An approval owns the keyboard: Select handles arrows/enter and the prompt
    // handles 1/2/3/Esc. Nothing below may scroll, submit or abort underneath it.
    if (pendingApproval) return;

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
      if (isMouseReport(input)) return;

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

      const count = picker === 'provider'
        ? providerItems.length
        : picker === 'model'
          ? modelItems.length
          : picker === 'session'
            ? sessionItems.length
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
        setPendingSessionDelete(null);
      }
      return;
    }

    // Terminal mouse report (SGR): wheel scrolls the transcript, a left press
    // inside the live thinking block toggles it, everything else is ignored.
    if (isMouseReport(input)) {
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
          if (clickedId) toggleStaticItem(clickedId);
          return;
        }
        const blockHeight = thinkingBlockHeight(thinkingText, thinkingExpanded, columns, rows);
        if (isClickOnThinkingBlock(press.y, rows, blockHeight)) {
          thinkingPinnedRef.current = true;
          setThinkingExpanded((expanded) => !expanded);
        }
      }
      return;
    }

    // Global shortcuts (ctrl or alt/option — Ink reports Alt as `key.meta`).
    // This sits after the picker/settings/API-key/mouse handlers so a modified
    // key can never be mistaken for a command while searching a picker or
    // confirming approval. a/e/u/w are left to PromptInput's text editing.
    const dismissible =
      !picker && settingsIndex === null && !keyPrompt && !pendingApproval && !pendingAsk;
    if (dismissible) {
      // Tab switches build <-> plan mode. PromptInput ignores Tab, so focus and
      // composition are unaffected.
      if (key.tab) {
        const next = mode === 'build' ? 'plan' : 'build';
        setMode(next);
        showToast(next === 'plan' ? 'PLAN MODE — no file changes' : 'BUILD MODE', 0);
        return;
      }
      // Copy the last visible transcript card. Never throws when xclip/pbcopy/
      // termux-clipboard-set is unavailable.
      if ((key.ctrl && input === 'y') || (key.meta && input === 'c')) {
        const card = visibleItems[visibleItems.length - 1];
        const text = card ? nodeText(card.node) : '';
        if (text) {
          void copyToClipboard(text);
          showToast('Copied message', 0);
        }
        return;
      }
      // Some terminals send ctrl+, / ctrl+/ as raw control bytes with no
      // modifier flags; normalise them so both spellings work.
      const ch = input === '\x1c' ? ',' : input === '\x1f' ? '/' : input;
      if (key.ctrl || key.meta || ch !== input) {
        const pageRows = Math.max(1, Math.floor(viewportRows / 2));
        const toggleHelp = () =>
          setHelpMessage((prev) => (prev ? null : buildHelpText(effectiveApprovalMode)));
        switch (ch) {
          case 'r': {
            // Ctrl+R regenerates: abort the in-flight turn, then re-submit the
            // last user text. The text is left in the composer for editing.
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
            return;
          }
          case 'e': {
            // Ctrl+E collapses all expandable cards (or expands them all).
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
          case 'n': void handleSlashCommand('/new'); return;
          case 's': void openSessionPicker(); return;
          case 'm': void handleSlashCommand('/model'); return;
          case 'p': void handleSlashCommand('/provider'); return;
          case 'v': void handleSlashCommand('/variant'); return;
          case 'h': toggleHelp(); return;
          case '/': toggleHelp(); return;
          case ',': void handleSlashCommand('/settings'); return;
          case 'q': void openSessionPicker(); return;
          case 'k':
            setInputText('');
            setInputResetKey((prev) => prev + 1);
            return;
          case 'l':
            setStaticItems([]);
            setUserScroll(0);
            return;
          case 't':
            if (thinkingText) {
              thinkingPinnedRef.current = true;
              setThinkingExpanded((expanded) => !expanded);
            }
            return;
          case 'b':
            scrollBy(pageRows);
            return;
          case 'f':
            scrollBy(-pageRows);
            return;
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
    if (!picker && settingsIndex === null && !pendingApproval && !pendingAsk && !(inputText.startsWith('/') && commandItems.length > 0)) {
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
      if (key.upArrow) {
        scrollBy(key.shift ? 3 : 1);
        return;
      }
      if (key.downArrow) {
        scrollBy(-(key.shift ? 3 : 1));
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
      return;
    }

    if (inputText.startsWith('/') && commandItems.length > 0) {
      if (key.upArrow) {
        setCommandIndex((index) => (index - 1 + commandItems.length) % commandItems.length);
        return;
      }
      if (key.downArrow) {
        setCommandIndex((index) => (index + 1) % commandItems.length);
        return;
      }
    }

    if (key.escape && loading && abortControllerRef.current) {
      // Abort the current completion
      abortControllerRef.current.abort();
    }
  });

  // Fresh filter results start at the first row.
  useEffect(() => {
    setCommandIndex(0);
  }, [inputText]);

  const chosenVariant = VARIANTS.find((item) => item.id === variantId) ?? VARIANTS[0];
  const remoteModelLabel = config
    ? remoteModels[config.provider]?.find((item) => item.id === config.model)?.label
    : undefined;
  const providerLabel = config ? getProvider(config.provider)?.name ?? config.provider : '';
  const modelLabel = config
    ? `${providerLabel} / ${remoteModelLabel ?? getModelDetails(config.provider, config.model)?.name ?? config.model}`
    : 'not configured';
  const folderName = basename(process.cwd());
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
  // Responsive breakpoints live in utils/layout.ts so every panel agrees.
  const layout = resolveLayout(columns, rows);
  const composerWidth = composerTextWidth(layout.inputWidth, layout.showSubmitHint);
  const { paletteWindow, visibleTodos, gutter, dense } = layout;
  const inputFocused =
    initialized && picker === null && settingsIndex === null && keyPrompt === null;

  // Provider-driven only: the block appears when the model actually streams
  // reasoning, never just because a request is in flight. A busy agent with no
  // reasoning used to render an empty "Thinking..." row that implied the model
  // was thinking when the provider had sent nothing.
  const hasThinkingBlock = initialized && !thinkingArchived && thinkingText.length > 0;
  const thinkingActive = thinkingStartedAt !== null && !thinkingArchived;
  // Ask the panel for its exact height instead of re-deriving it here; the two
  // drifted apart (the "more" markers add rows) and squeezed the composer.
  const todoRows = todoPanelRows(todos, visibleTodos);
  // Same function the click hit-test uses, so layout and clicks cannot drift.
  const thinkingRows = hasThinkingBlock
    ? thinkingBlockHeight(thinkingText, thinkingExpanded, columns, rows)
    : 0;
  const helpRows = helpMessage ? helpMessage.split('\n').length + 3 : 0;
  // Budget the live area from the frame, so panels appearing or going away
  // (todos added, todos cleared) automatically hand space back to the
  // transcript instead of squeezing it or pushing the composer off-screen.
  const streamReserve = isStreaming ? Math.min(rows, 10) : 0;
  const subAgentRows = showSubAgentPanel ? subAgentActivityRows(subAgentActivities) : 0;
  const area = splitLiveArea(frameHeight, {
    todos: todoRows,
    thinking: thinkingRows,
    help: helpRows,
    streaming: streamReserve + subAgentRows,
  });
  const maxStreamRows = Math.max(1, area.transcriptRows);

  // Rail geometry. `viewportRows` is measured from the real layout, so the
  // thumb lines up with what is actually on screen.
  const scrollbar = scrollbarGeometry(transcriptRows, viewportRows, effectiveUserScroll);
  const railLines = restoringTranscript ? [] : scrollbarLines(scrollbar);

  // A critical modal owns the full frame so all options stay visible on tiny
  // terminals. This can trigger Ink's full-repaint path while navigating,
  // which is an acceptable tradeoff for a modal that is not streaming.
  return (
    <Box flexDirection="column" height={hasCriticalPrompt ? rows : frameHeight}>
      {/* Scrollable transcript viewport; the input and footer below stay fixed.
          A modal prompt removes it entirely so the prompt keeps every row. */}
      {!hasCriticalPrompt && (
      <Box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
        <Box
          ref={viewportRef}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={1}
          overflow="hidden"
          flexDirection="column"
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

      {/* Live area: only these few rows re-render while typing. The horizontal
          rule that used to sit here is gone; the composer's own accent bar is
          the only border, so there is no double edge between chat and input. */}
      {/* A modal replaces the composer, so it sits bottom-aligned in the full-height live region. */}
      <Box
        flexDirection="column"
        flexGrow={hasCriticalPrompt ? 1 : 0}
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        justifyContent={hasCriticalPrompt ? 'flex-end' : undefined}
      >
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

        {hasThinkingBlock && !hasCriticalPrompt && (
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
        )}

        {isStreaming && !hasCriticalPrompt && looksLikeDiff(streamingText) ? (
          <DiffView
            header="Streaming diff"
            diff={clipToRows(streamingText, Math.max(2, maxStreamRows - 3), columns)}
            maxRows={Math.max(2, maxStreamRows - 3)}
          />
        ) : isStreaming && !hasCriticalPrompt ? (
          <Box paddingX={gutter} paddingBottom={dense ? 0 : 1}>
            <Text wrap="truncate-end">
              {renderFormattedText(
                clipToRows(streamingText, maxStreamRows, columns - gutter * 2),
                columns - gutter * 2
              )}
              <Text dimColor>▍</Text>
            </Text>
          </Box>
        ) : null}

        {!hasCriticalPrompt && threadErrors.filter((threadError) => threadError.transient).map((threadError) => (
          <Box key={`thread-error-${threadError.id}`} paddingX={2}>
            <LeftBar color={theme.muted} marginBottom={1}>
              <Text color={theme.muted}>{threadError.message}</Text>
            </LeftBar>
          </Box>
        ))}

        {/* Agent question. Takes over the composer area so the user answers
            here instead of typing into the normal prompt. */}
        {pendingAsk && !pendingApproval && (
          <AskPrompt
            questions={pendingAsk.request.questions}
            columns={columns}
            compact={dense || rows <= 10}
            onRespond={(response) => {
              pendingAsk.resolve(response);
              setPendingAsk(null);
            }}
          />
        )}

        {/* Approval prompt. Enrich the detail with the target file path when the
            most recent tool call carries one (manual review before writing). */}
        {pendingApproval && (
          <ApprovalPrompt
            request={(() => {
              const request = pendingApproval.request;
              const path = extractPathFromArgs(lastToolCallRef.current?.args);
              if (!path || request.detail?.includes(path)) return request;
              return {
                ...request,
                detail: [request.detail, `File: ${path}`].filter(Boolean).join('\n'),
              };
            })()}
            columns={columns}
            compact={dense || rows <= 10}
            rows={rows}
            onRespond={(response) => {
              pendingApproval.resolve(response);
              setPendingApproval(null);
            }}
          />
        )}

        {/* Pickers and slash-command palette */}
        {keyPrompt && (
          <ApiKeyPrompt
            providerName={keyPrompt.providerName}
            path={keyPrompt.path}
            error={keyPrompt.error}
            busy={keyPrompt.busy}
            columns={columns}
            compact={dense || rows <= 10}
            onSubmit={(value) => { void handleApiKeySubmit(value); }}
          />
        )}
        {picker === 'model' && (
          <Box flexDirection="column">
            <Box paddingX={2}>
              <Text color={theme.dim}>Search </Text>
              <Text color={theme.text}>{modelSearch}</Text>
              <Text inverse>{' '}</Text>
            </Box>
            {modelItems.length > 0 ? (
              <>
                {(modelsLoading || modelNotice) && (
                  <Box paddingX={2}>
                    <Text color={theme.dim} wrap="truncate-end">
                      {modelsLoading
                        ? `Fetching models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
                        : modelNotice}
                    </Text>
                  </Box>
                )}
                <Palette
                  title={modelProvider ? `Select model · ${modelProvider.name}` : 'Select model'}
                  items={modelItems}
                  selected={selectedModelIndex}
                  maxVisible={paletteWindow}
                  hint="type to search · ↑↓ select · enter use · esc cancel"
                />
              </>
            ) : (
              <Box paddingX={2}>
                <Text color={modelsLoading ? theme.dim : theme.error}>
                  {modelsLoading
                    ? `Loading models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
                    : modelSearch.trim()
                      ? `No models match "${modelSearch}".`
                      : modelNotice ?? 'No models available.'}
                </Text>
              </Box>
            )}
          </Box>
        )}
        {picker === 'provider' && (
          <Palette title="Select provider" items={providerItems} selected={clampIndex(pickerIndex, providerItems.length)} maxVisible={paletteWindow} hint="↑↓ select · enter use · esc cancel" />
        )}
        {picker === 'session' && (
          sessionItems.length > 0 ? (
            <Palette
              title={
                pendingSessionDelete
                  ? `Delete session "${pendingSessionDelete.label}"?`
                  : 'Select session'
              }
              items={sessionItems}
              selected={clampIndex(pickerIndex, sessionItems.length)}
              maxVisible={paletteWindow}
              hint={
                pendingSessionDelete
                  ? 'y delete permanently · n cancel'
                  : '↑↓ select · enter resume · d delete · esc close'
              }
            />
          ) : (
            <Box paddingX={2}>
              <Text color={sessionsLoading ? theme.dim : theme.muted}>
                {sessionsLoading ? 'Loading sessions…' : 'No saved sessions. Press esc to close.'}
              </Text>
            </Box>
          )
        )}
        {picker === 'variant' && (
          <Palette title="Select variant" items={variantItems} selected={clampIndex(pickerIndex, variantItems.length)} maxVisible={paletteWindow} hint="↑↓ select · enter use · esc cancel" />
        )}
        {picker === 'statusLine' && (
          <Palette title="Status line segments" items={statusLineItems} selected={clampIndex(pickerIndex, statusLineItems.length)} maxVisible={paletteWindow} hint="↑↓ select · enter toggle · esc back" />
        )}
        {settingsIndex !== null && (
          <Palette title="Settings" items={settingItems} selected={settingsIndex} maxVisible={paletteWindow} hint="↑↓ select · enter toggle · esc close" />
        )}
        {!picker && !keyPrompt && settingsIndex === null && initialized && !hasCriticalPrompt && inputText.startsWith('/') && (
          <Palette items={commandItems} selected={commandIndex} maxVisible={paletteWindow} />
        )}
      </Box>

      {/* Composer: a borderless text area with one blue accent bar on the
          left. The old full box drew a bright outline around every keystroke;
          a single edge keeps the focus cue without boxing the text in.
          The gaps above and inside give the input room to breathe. */}
      {initialized && !pendingApproval && !pendingAsk && !keyPrompt && (
        <Box flexDirection="column" alignItems="center" flexShrink={0}>
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
              height={1}
              flexShrink={0}
            />
            <Box flexGrow={1} minWidth={1} paddingRight={2} height={1} overflow="hidden">
              <PromptInput
                key={inputResetKey}
                value={inputText}
                onChange={setInputText}
                onSubmit={submitSafely}
                isDisabled={picker !== null || settingsIndex !== null || keyPrompt !== null}
                placeholder="Build anything…"
                width={composerWidth}
              />
            </Box>
            {layout.showSubmitHint && (
              <Box paddingRight={1} height={1} flexShrink={0}>
                <Text color={theme.dim}>{'↵'}</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Status: folder · model · variant · context — hidden while a modal
          prompt owns the screen so the prompt keeps every available row. */}
      {initialized && !hasCriticalPrompt && (
        <UsageDisplay
          usage={lastUsage ?? null}
          totalCost={totalCost}
          modelLabel={modelLabel}
          variantLabel={chosenVariant.label}
          variantColor={chosenVariant.color}
          folder={folderName}
          busy={loading}
          tool={activeTool}
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

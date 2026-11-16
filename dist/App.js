import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { LeftBar } from './components/LeftBar.js';
import { Palette, SLASH_COMMANDS } from './components/Palette.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { AskPrompt } from './components/AskPrompt.js';
import { ApiKeyPrompt } from './components/ApiKeyPrompt.js';
import { DiffView } from './components/DiffView.js';
import { ReadFileView } from './components/ReadFileView.js';
import { UsageDisplay } from './components/UsageDisplay.js';
import { ThinkingBlock, thinkingBlockHeight } from './components/ThinkingBlock.js';
import { TodoPanel, todoPanelRows } from './components/TodoPanel.js';
import { theme } from './theme.js';
import { loadSettings, saveSettings } from './settings.js';
import { VARIANTS } from './variants.js';
import { PromptInput } from './components/PromptInput.js';
import { OpenAI } from 'openai';
import { getRuntimeConfigPath, readConfig, resolveApiKey, writeActiveSelection, writeProviderApiKey } from './config.js';
import { getActiveRuntimeConfigPath, loadRuntimeConfig } from './runtime-config.js';
import { getAllProviders, getProvider, getModelDetails, getModelPricing, getRequestDefaultParams } from './providers/index.js';
import { runAgenticLoop, initializeMessages, } from './agentic-loop.js';
import { setDangerouslySkipPermissions, setApprovalHandler, clearApprovalHandler, setAskHandler, } from './tools/index.js';
import { setLogLevel, LogLevel, initLogFile, logger } from './utils/logger.js';
import { createSession, ensureSystemPromptAtTop, saveSession, loadSession, listSessions, generateTitle, } from './sessions.js';
import { clearTodos, getTodosForSession, setTodosForSession } from './tools/todo.js';
import { initializeMcp, closeMcp } from './mcp.js';
import { generateSystemPrompt } from './system-prompt.js';
import { renderFormattedText, normalizeTranscriptText } from './utils/format-message.js';
import { parseFileMutationDiff, parseFileReadResult } from './utils/file-diff.js';
import { formatContextWindow, listProviderModels } from './utils/provider-models.js';
import { formatToolActivity } from './utils/tool-display.js';
import { getLeftMousePress, getWheelDelta, isClickOnThinkingBlock, isMouseReport, stripMouseReports } from './utils/mouse.js';
import { nextThinkingExpansion } from './utils/thinking-expansion.js';
import { clampScroll, maxScrollOffset, scrollAfterGrowth, sliceItemsToWindow, visibleRowWindow, } from './utils/scroll.js';
import { frameRows, resolveLayout, splitLiveArea } from './utils/layout.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from './utils/scrollbar.js';
import { useAgentEventHandler } from './hooks/useAgentEventHandler.js';
// Keep scrollback rendering light on long sessions and low-memory devices.
const MAX_STATIC_ITEMS = 120;
// Resumed sessions keep their full model context, but replay only the tail to
// scrollback so a huge transcript does not flood the terminal at once.
const MAX_REPLAY_MESSAGES = 100;
// Avoid refetching a provider's model list on every /model open.
const MODEL_CACHE_TTL_MS = 5 * 60_000;
function fallbackItemRows(node) {
    if (!node)
        return 0;
    if (typeof node === 'string' || typeof node === 'number')
        return 1;
    if (React.isValidElement(node)) {
        const children = node.props.children;
        if (typeof children === 'string' || typeof children === 'number') {
            return Math.max(1, String(children).split('\n').length);
        }
    }
    return 2;
}
/** Renders one transcript row-group and reports its real height for scrolling. */
const StaticEntry = React.memo(({ item, columns, onMeasure }) => {
    const ref = React.useRef(null);
    React.useEffect(() => {
        if (!ref.current)
            return;
        const height = measureElement(ref.current).height;
        if (height > 0)
            onMeasure(item.id, height);
    }, [item.id, item.node, columns, onMeasure]);
    return (_jsx(Box, { ref: ref, flexDirection: "column", children: item.node }));
});
// Wordmark printed once as static output. Typing only re-renders the small
// live region below it, so the terminal never blinks.
const SPLASH_LINES = [
    '█▄▄ █ ▀█▀ ▄▀█ █▀▀ █▀█ █▀▄ █▀▀',
    '█▄█ █  █  █▀█ █▄▄ █▄█ █▄▀ ██▄',
];
function printSplash(addStatic, columns) {
    if (columns < 36)
        return;
    const width = SPLASH_LINES[0].length;
    const leftPad = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
    // One row of breathing room. The wordmark used to be vertically centred,
    // which pushed it into the transcript and made it collide with the first
    // messages on short terminals.
    const body = SPLASH_LINES.map((line) => leftPad + line).join('\n');
    addStatic(_jsx(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1, children: _jsx(Text, { color: theme.text, bold: true, children: body }) }));
}
function printMessageToScrollback(addStatic, role, text) {
    const normalized = normalizeTranscriptText(text);
    if (!normalized) {
        addStatic(_jsx(Box, { height: 1 }));
        return;
    }
    if (role === 'user') {
        addStatic(_jsx(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: _jsx(Box, { borderStyle: "single", borderTop: false, borderRight: false, borderBottom: false, borderLeftColor: theme.userBorder, paddingLeft: 1, children: _jsx(Text, { color: theme.userText, children: normalized }) }) }));
        return;
    }
    // Fallback is assistant, render with Markdown formatting (bold, italic)
    addStatic(_jsx(Box, { paddingX: 2, paddingBottom: 1, children: _jsx(Text, { children: renderFormattedText(normalized) }) }));
}
function replayMessagesToScrollback(addStatic, messages, maxMessages = messages.length) {
    const omitted = Math.max(0, messages.length - maxMessages);
    const visible = omitted > 0 ? messages.slice(omitted) : messages;
    if (omitted > 0) {
        addStatic(_jsx(Box, { paddingX: 2, children: _jsxs(Text, { color: theme.dim, children: ["\u2026 ", omitted, " earlier message", omitted === 1 ? '' : 's', " kept in model context, not replayed \u2026"] }) }));
    }
    for (const message of visible) {
        const msgAny = message;
        if (message.role === 'system')
            continue;
        if (message.role === 'user' && typeof message.content === 'string') {
            printMessageToScrollback(addStatic, 'user', message.content);
            continue;
        }
        if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0) {
            printMessageToScrollback(addStatic, 'assistant', message.content);
            continue;
        }
        if (message.role === 'tool') {
            const toolName = msgAny.name || 'tool';
            const rawResult = String(msgAny.content || '');
            const compact = rawResult.replace(/\s+/g, ' ').trim().slice(0, 180);
            // Format tool display with args if available
            let toolDisplay = toolName;
            if (msgAny.args) {
                try {
                    const args = JSON.parse(msgAny.args);
                    toolDisplay = formatToolActivity(toolName, args);
                }
                catch {
                    // If parsing fails, use the tool name
                }
            }
            const fileDiff = parseFileMutationDiff(toolName, msgAny.args, rawResult);
            if (fileDiff) {
                addStatic(_jsx(DiffView, { header: fileDiff.header, diff: fileDiff.diff, filePath: fileDiff.filePath, operation: fileDiff.operation }));
                continue;
            }
            const fileRead = parseFileReadResult(toolName, msgAny.args, rawResult);
            if (fileRead) {
                addStatic(_jsx(ReadFileView, { ...fileRead }));
                continue;
            }
            const isError = /^(Error\b|File not found\b|Operation cancelled\b)/i.test(rawResult.trim());
            addStatic(_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsxs(Text, { color: isError ? theme.error : undefined, dimColor: !isError, children: ['▶ ', toolDisplay, ': ', compact] }) }));
        }
    }
    if (messages.length > 0) {
        addStatic(_jsx(Box, { height: 1 }));
    }
}
// Limit streaming text to the free viewport rows to prevent overflow that
// would trigger Ink's clearTerminal() and wipe scrollback history. Completed
// lines are archived to <Static>; only the last visible lines stay live.
function clipToRows(text, maxRows) {
    const maxLines = Math.max(1, maxRows);
    const lines = text.split('\n');
    if (lines.length <= maxLines)
        return text;
    return lines.slice(lines.length - maxLines).join('\n');
}
// ─── Spinner frames for loading indicator ───
// ─── Help text derived from slash commands ───
const HELP_TEXT = [
    'Commands:',
    ...SLASH_COMMANDS.map((cmd) => `  ${cmd.name} - ${cmd.description}`),
    '',
    'Keys:',
    '  ctrl+t - expand/collapse thinking',
    '  esc    - close help / cancel the running turn',
].join('\n');
const SETTING_KEYS = ['animations', 'mouseClicks'];
function buildClient(config, apiKeyOverride) {
    const provider = getProvider(config.provider);
    const apiKey = apiKeyOverride?.trim() || resolveApiKey(config);
    if (!apiKey) {
        const providerName = provider?.name || config.provider;
        const envVar = provider?.apiKeyEnvVar;
        throw new Error(envVar
            ? `Missing API key for ${providerName}. Set it in config or export ${envVar}.`
            : `Missing API key for ${providerName}.`);
    }
    const clientOptions = {
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
        const defaultHeaders = {};
        for (const line of rawHeaders.split('\n')) {
            const sep = line.indexOf(': ');
            if (sep === -1)
                continue;
            const key = line.slice(0, sep).trim();
            const value = line.slice(sep + 2).trim();
            if (key && value)
                defaultHeaders[key] = value;
        }
        if (Object.keys(defaultHeaders).length > 0) {
            clientOptions.defaultHeaders = defaultHeaders;
        }
    }
    else if (provider?.headers && Object.keys(provider.headers).length > 0) {
        clientOptions.defaultHeaders = provider.headers;
    }
    return new OpenAI(clientOptions);
}
// ─── Main App ───
export const App = ({ dangerouslySkipPermissions = false, logLevel, sessionId, }) => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [dims, setDims] = useState({
        columns: stdout?.columns || 80,
        rows: stdout?.rows || 24,
    });
    const { columns, rows } = dims;
    // One row shorter than the terminal. Rendering at exactly `rows` makes Ink
    // take its full-screen path (`clearTerminal` + full repaint) on every frame,
    // which is the blinking seen while scrolling and streaming.
    const frameHeight = frameRows(rows);
    // ─── Static scrollback state ───
    // Each item is rendered once by <Static> and permanently flushed to scrollback.
    // staticCounterRef generates unique IDs (s1, s2, s3...) for React keys.
    const staticCounterRef = useRef(0);
    const [staticItems, setStaticItems] = useState([]);
    // Transcript scroll: rows above the bottom of the visible viewport.
    const [userScroll, setUserScroll] = useState(0);
    const [viewportRows, setViewportRows] = useState(Math.max(1, rows - 8));
    const [measuredHeights, setMeasuredHeights] = useState({});
    const viewportRef = useRef(null);
    const addStatic = useCallback((node) => {
        staticCounterRef.current += 1;
        const id = `s${staticCounterRef.current}`;
        // Bound the React tree: the terminal keeps printed scrollback, but old
        // nodes should not accumulate in memory on long sessions.
        setStaticItems((prev) => {
            const next = [...prev, { id, node }];
            return next.length > MAX_STATIC_ITEMS ? next.slice(next.length - MAX_STATIC_ITEMS) : next;
        });
    }, []);
    const handleMeasureItem = useCallback((id, rows) => {
        setMeasuredHeights((prev) => (prev[id] === rows ? prev : { ...prev, [id]: rows }));
    }, []);
    // Core state
    const [config, setConfig] = useState(null);
    const [completionMessages, setCompletionMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamingText, setStreamingText] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [helpMessage, setHelpMessage] = useState(null);
    const [threadErrors, setThreadErrors] = useState([]);
    const [initialized, setInitialized] = useState(false);
    const [screenReady, setScreenReady] = useState(false);
    // User-facing preferences + live reasoning/todo state
    const [settings, setSettings] = useState(loadSettings);
    const [settingsIndex, setSettingsIndex] = useState(null);
    const [thinkingText, setThinkingText] = useState('');
    // Expansion is driven by the provider: reasoning opens the block, and it
    // folds when reasoning ends. There is no preset to start expanded.
    const [thinkingExpanded, setThinkingExpanded] = useState(false);
    // While reasoning streams in, the block opens automatically so the user can
    // read it live; when the reasoning ends it folds back to a one-line header.
    // This flag records a manual toggle so the auto-expand does not fight it.
    const thinkingPinnedRef = useRef(false);
    const [thinkingStartedAt, setThinkingStartedAt] = useState(null);
    const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
    const [thinkingArchived, setThinkingArchived] = useState(false);
    const [todos, setTodos] = useState([]);
    // Input reset key — incremented on submit to force TextInput remount and clear
    const [inputResetKey, setInputResetKey] = useState(0);
    // Palette state: slash-command list, provider/model/variant pickers
    const [commandIndex, setCommandIndex] = useState(0);
    const [picker, setPicker] = useState(null);
    const [pickerIndex, setPickerIndex] = useState(0);
    const [variantId, setVariantId] = useState(settings.variant);
    const [remoteModels, setRemoteModels] = useState({});
    const [pendingProviderId, setPendingProviderId] = useState(null);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelNotice, setModelNotice] = useState(null);
    const [keyPrompt, setKeyPrompt] = useState(null);
    const [modelSearch, setModelSearch] = useState('');
    const [sessionItems, setSessionItems] = useState([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    // Approval state
    const [pendingAsk, setPendingAsk] = useState(null);
    const [pendingApproval, setPendingApproval] = useState(null);
    // Usage state
    const [lastUsage, setLastUsage] = useState(null);
    const [totalCost, setTotalCost] = useState(0);
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    // Active tool tracking — shows which tool is currently executing
    const [activeTool, setActiveTool] = useState(null);
    // Session state
    const [session, setSession] = useState(null);
    // OpenAI client ref (stable across renders)
    const clientRef = useRef(null);
    // Invalidates stale /models responses when the picker is reopened or closed.
    const modelFetchSeqRef = useRef(0);
    // Latest search text for async /models responses.
    const modelSearchRef = useRef('');
    const remoteModelsRef = useRef({});
    const modelCacheTimeRef = useRef({});
    // Whether the transcript on disk matches what the user has seen
    const sessionSavedRef = useRef(false);
    const assistantMessageRef = useRef(null);
    // Latest reasoning for the current turn; refs survive stale loop closures.
    const reasoningRef = useRef('');
    // Abort controller for cancelling the current completion
    const abortControllerRef = useRef(null);
    // Monotonic run id. /new bumps it so an older run cannot write its results
    // into the new session after being aborted.
    const activeRunRef = useRef(0);
    // Buffer for streaming text that accumulates content and flushes complete lines to static
    // This prevents the live streaming area from growing unbounded - complete lines are
    // immediately flushed to <Static>, only the incomplete final line stays in the dynamic frame
    const streamingBufferRef = useRef({
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
    const didPrintIntroRef = useRef(false);
    const printedThreadErrorIdsRef = useRef(new Set());
    const initializeWithConfig = useCallback(async (loadedConfig) => {
        setConfig(loadedConfig);
        clientRef.current = buildClient(loadedConfig);
        // Initialize MCP servers
        await initializeMcp();
        // Load or create session
        let loadedSession = null;
        if (sessionId) {
            loadedSession = await loadSession(sessionId);
            if (loadedSession) {
                const systemPrompt = await generateSystemPrompt();
                loadedSession.completionMessages = ensureSystemPromptAtTop(loadedSession.completionMessages, systemPrompt);
                const savedVariant = loadedSession.variant;
                const restoredVariant = savedVariant && VARIANTS.some((item) => item.id === savedVariant)
                    ? savedVariant
                    : undefined;
                if (restoredVariant)
                    setVariantId(restoredVariant);
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
                            const target = getActiveRuntimeConfigPath() === getRuntimeConfigPath('project')
                                ? 'project'
                                : 'user';
                            writeActiveSelection(candidate.provider, candidate.model, target);
                        }
                        catch (err) {
                            logger.warn('Could not persist resumed session selection', { error: err.message });
                        }
                    }
                    catch (err) {
                        setError(`Session model ${loadedSession.provider}/${loadedSession.model} is unavailable: ${err.message}`);
                    }
                }
                loadedSession.provider = sessionConfig.provider;
                loadedSession.model = sessionConfig.model;
                setConfig(sessionConfig);
                setTodosForSession(loadedSession.id, loadedSession.todos);
                setSession(loadedSession);
                setCompletionMessages(loadedSession.completionMessages);
                if (!didPrintIntroRef.current) {
                    printSplash(addStatic, columns);
                    replayMessagesToScrollback(addStatic, loadedSession.completionMessages, MAX_REPLAY_MESSAGES);
                    didPrintIntroRef.current = true;
                    sessionSavedRef.current = true;
                }
            }
            else {
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
            if (!didPrintIntroRef.current) {
                printSplash(addStatic, columns);
                didPrintIntroRef.current = true;
            }
        }
        setInitialized(true);
    }, [dangerouslySkipPermissions, sessionId, addStatic, columns, rows]);
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
    useEffect(() => {
        if (error) {
            addStatic(_jsx(Box, { paddingX: 2, children: _jsxs(Text, { color: theme.error, children: ["Error: ", error] }) }));
        }
    }, [error, addStatic]);
    useEffect(() => {
        for (const threadError of threadErrors) {
            if (threadError.transient || printedThreadErrorIdsRef.current.has(threadError.id)) {
                continue;
            }
            printedThreadErrorIdsRef.current.add(threadError.id);
            addStatic(_jsx(Box, { paddingX: 2, children: _jsxs(Text, { color: theme.error, children: ["Error: ", threadError.message] }) }));
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
    // Alternate screen keeps the fixed input/footer on screen while the
    // transcript scrolls inside its own viewport.
    useEffect(() => {
        if (!stdout)
            return;
        stdout.write('\x1b[?1049h');
        stdout.write(`\x1b]11;${theme.bg}\x07`);
        stdout.write('\x1b[2J\x1b[H');
        setScreenReady(true);
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
        if (!stdout)
            return;
        if (!mouseTrackingEnabled) {
            stdout.write('\x1b[?1006l\x1b[?1000l');
            return;
        }
        stdout.write('\x1b[?1000h\x1b[?1006h');
        return () => {
            stdout.write('\x1b[?1006l\x1b[?1000l');
        };
    }, [stdout, mouseTrackingEnabled]);
    // Re-render at the new size when the terminal is resized.
    useEffect(() => {
        if (!stdout)
            return;
        const onResize = () => {
            setDims({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        };
        stdout.on('resize', onResize);
        return () => {
            stdout.off('resize', onResize);
        };
    }, [stdout]);
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
        picker ?? '',
        settingsIndex !== null ? 1 : 0,
        initialized ? 1 : 0,
    ].join(':');
    useEffect(() => {
        if (!viewportRef.current)
            return;
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
                const level = LogLevel[logLevel.toUpperCase()];
                if (level !== undefined) {
                    setLogLevel(level);
                    initLogFile();
                    logger.info(`Bitacode started with log level: ${logLevel}`);
                    logger.info(`Log file: ${logger.getLogFilePath()}`);
                }
            }
            // Set global approval mode
            if (dangerouslySkipPermissions) {
                setDangerouslySkipPermissions(true);
            }
            // Register interactive approval handler
            setApprovalHandler(async (req) => {
                return new Promise((resolve) => {
                    setPendingApproval({ request: req, resolve });
                });
            });
            // The agent can pause to ask the user a question; the UI owns the
            // interaction and resolves the promise with the collected answers.
            setAskHandler(async (req) => {
                return new Promise((resolve) => {
                    setPendingAsk({ request: req, resolve });
                });
            });
            await loadRuntimeConfig();
            const loadedConfig = readConfig('active');
            if (!loadedConfig) {
                setError('No config found. Run: bitacode configure');
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
    const commandItems = SLASH_COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(inputText.trim().toLowerCase())).map((cmd) => ({ id: cmd.name, label: cmd.name, description: cmd.description }));
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
    const staticModelItems = (modelProvider?.models ?? []).map((model) => ({
        id: model.id,
        label: model.name,
        description: formatContextWindow(model.contextWindow),
        contextWindow: model.contextWindow,
    }));
    const cachedModelItems = modelProviderId ? remoteModels[modelProviderId] : undefined;
    const allModelItems = cachedModelItems && cachedModelItems.length > 0 ? cachedModelItems : staticModelItems;
    const modelSearchTerm = modelSearch.trim().toLowerCase();
    const modelItems = modelSearchTerm
        ? allModelItems.filter((item) => item.label.toLowerCase().includes(modelSearchTerm) ||
            item.id.toLowerCase().includes(modelSearchTerm))
        : allModelItems;
    const selectedModelIndex = Math.min(pickerIndex, Math.max(0, modelItems.length - 1));
    const variantItems = VARIANTS.map((variant) => ({
        id: variant.id,
        label: variant.label,
        color: variant.color,
        bold: true,
    }));
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
    ];
    const toggleSetting = useCallback((index) => {
        const key = SETTING_KEYS[index];
        if (!key)
            return;
        const next = { ...settings, [key]: !settings[key] };
        setSettings(next);
        saveSettings(next);
    }, [settings]);
    const persistActiveSelection = useCallback((providerId, modelId, modelInfo) => {
        try {
            const target = getActiveRuntimeConfigPath() === getRuntimeConfigPath('project') ? 'project' : 'user';
            writeActiveSelection(providerId, modelId, target, process.cwd(), modelInfo);
        }
        catch (err) {
            setError(`Selection applies to this session but could not be saved: ${err.message}`);
        }
    }, []);
    const getModelPaletteInfo = useCallback((providerId, modelId) => {
        const remote = remoteModelsRef.current[providerId]?.find((item) => item.id === modelId);
        if (remote)
            return { name: remote.label, contextWindow: remote.contextWindow };
        const details = getModelDetails(providerId, modelId);
        return details ? { name: details.name, contextWindow: details.contextWindow } : undefined;
    }, []);
    const loadModels = useCallback(async (providerId, client, preferredModelId) => {
        const cached = remoteModelsRef.current[providerId];
        const cachedAt = modelCacheTimeRef.current[providerId] ?? 0;
        if (cached?.length &&
            cachedAt > 0 &&
            Date.now() - cachedAt < MODEL_CACHE_TTL_MS) {
            if (!modelSearchRef.current && preferredModelId) {
                const index = cached.findIndex((item) => item.id === preferredModelId);
                if (index >= 0)
                    setPickerIndex(index);
            }
            return;
        }
        const seq = ++modelFetchSeqRef.current;
        setModelsLoading(true);
        setModelNotice(null);
        const result = await listProviderModels(client, providerId);
        if (seq !== modelFetchSeqRef.current)
            return;
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
            setModelNotice(staticCount > 0
                ? `Could not fetch models (${result.error}); using built-in list.`
                : `Could not fetch models: ${result.error}`);
        }
        else if (result.items.length === 0) {
            setModelNotice(staticCount > 0
                ? 'The provider returned no models; using built-in list.'
                : 'The provider returned no models.');
        }
    }, []);
    const beginProviderSwitch = useCallback((providerId) => {
        const provider = getProvider(providerId);
        if (!provider)
            return;
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
        }
        catch (err) {
            setError(`Cannot switch to ${provider.name}: ${err.message}`);
            setPendingProviderId(null);
            setPicker(null);
            setModelsLoading(false);
        }
    }, [loadModels]);
    const handleApiKeySubmit = useCallback(async (value) => {
        const prompt = keyPrompt;
        if (!prompt || prompt.busy)
            return;
        const apiKey = value.trim();
        if (!apiKey) {
            setKeyPrompt({ ...prompt, error: 'API key cannot be empty.' });
            return;
        }
        setKeyPrompt({ ...prompt, busy: true, error: null });
        let client;
        try {
            client = buildClient({ provider: prompt.providerId, model: '' }, apiKey);
        }
        catch (err) {
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
        }
        catch (err) {
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
        setKeyPrompt(null);
        setPendingProviderId(prompt.providerId);
        setPicker('model');
        setPickerIndex(0);
        setModelSearch('');
        setModelsLoading(false);
        setModelNotice(result.error
            ? `Could not fetch models (${result.error}); using built-in list.`
            : null);
    }, [keyPrompt]);
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
        setThreadErrors([]);
        setLastUsage(null);
        setTotalCost(0);
        setInputText('');
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
        sessionSavedRef.current = false;
    }, []);
    const startNewSession = useCallback(async () => {
        if (!config) {
            setError('Cannot start a new session: no provider/model is configured.');
            return;
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
            const hasConversation = completionMessages.some((message) => message.role !== 'system');
            if (session && hasConversation) {
                const finished = {
                    ...session,
                    completionMessages,
                    todos: getTodosForSession(session.id),
                    title: generateTitle(completionMessages),
                    variant: variantId,
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
            if (previousSessionId)
                clearTodos(previousSessionId);
            // Fresh canvas for the new session.
            stdout?.write('\x1b[2J\x1b[H');
            setStaticItems([]);
            setUserScroll(0);
            printSplash(addStatic, columns);
            addStatic(_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsxs(Text, { color: theme.dim, children: ["New session \u00B7 ", config.provider, " / ", config.model] }) }));
        }
        catch (err) {
            setError(`Failed to start a new session: ${err.message}`);
        }
    }, [
        config,
        session,
        completionMessages,
        variantId,
        addStatic,
        columns,
        rows,
        resetLiveState,
        stdout,
    ]);
    const openSessionPicker = useCallback(async () => {
        setSessionsLoading(true);
        setSessionItems([]);
        try {
            const summaries = await listSessions();
            const items = summaries.slice(0, 100).map((summary) => {
                const title = summary.title.length > 56 ? `${summary.title.slice(0, 53)}...` : summary.title;
                const model = summary.model ? summary.model.split('/').pop() : '';
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
        }
        catch (err) {
            setError(`Could not list sessions: ${err.message}`);
        }
        finally {
            setSessionsLoading(false);
        }
    }, [session?.id]);
    const switchSession = useCallback(async (id) => {
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
            const hasConversation = completionMessages.some((message) => message.role !== 'system');
            if (session && hasConversation) {
                await saveSession({
                    ...session,
                    completionMessages,
                    todos: getTodosForSession(session.id),
                    title: generateTitle(completionMessages),
                    variant: variantId,
                });
            }
            const systemPrompt = await generateSystemPrompt();
            const messages = ensureSystemPromptAtTop(loaded.completionMessages, systemPrompt);
            // Restore the session's own provider/model when it still has a key.
            const providerId = loaded.provider || config.provider;
            const modelId = loaded.model || config.model;
            let nextConfig = config;
            let modelError = null;
            try {
                clientRef.current = buildClient({ provider: providerId, model: modelId });
                nextConfig = { provider: providerId, model: modelId };
            }
            catch (err) {
                modelError = err.message;
            }
            const savedVariant = loaded.variant;
            const nextVariant = savedVariant && VARIANTS.some((item) => item.id === savedVariant)
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
            if (modelError) {
                setError(`Session loaded, but its model is unavailable: ${modelError}`);
            }
            stdout?.write('\x1b[2J\x1b[H');
            setStaticItems([]);
            setUserScroll(0);
            printSplash(addStatic, columns);
            replayMessagesToScrollback(addStatic, messages, MAX_REPLAY_MESSAGES);
            didPrintIntroRef.current = true;
            sessionSavedRef.current = true;
        }
        catch (err) {
            setError(`Could not open session: ${err.message}`);
        }
    }, [
        config,
        session,
        completionMessages,
        variantId,
        settings,
        addStatic,
        columns,
        rows,
        resetLiveState,
        persistActiveSelection,
        getModelPaletteInfo,
        stdout,
    ]);
    const handleSlashCommand = useCallback(async (cmd, raw = cmd) => {
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
                    const nextSession = {
                        ...session,
                        completionMessages,
                        todos: getTodosForSession(session.id),
                        title: generateTitle(completionMessages),
                        variant: variantId,
                    };
                    await saveSession(nextSession);
                    setSession(nextSession);
                    setError(null);
                    sessionSavedRef.current = true;
                    exit();
                }
                catch (err) {
                    setError(`Failed to save session before exit: ${err.message}`);
                }
                return true;
            case '/help':
                setHelpMessage(HELP_TEXT);
                return true;
            case '/new':
                void startNewSession();
                return true;
            case '/session':
                if (parts[1]) {
                    void switchSession(parts[1]);
                }
                else {
                    void openSessionPicker();
                }
                return true;
            case '/model':
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
        loadModels,
        startNewSession,
        switchSession,
        openSessionPicker,
    ]);
    const applyPicker = useCallback(() => {
        if (picker === 'model') {
            const item = modelItems[selectedModelIndex];
            if (item && config) {
                const providerId = pendingProviderId ?? config.provider;
                const switchingProvider = providerId !== config.provider;
                const nextConfig = {
                    ...config,
                    provider: providerId,
                    model: item.id,
                    ...(switchingProvider ? { apiKey: undefined } : {}),
                };
                if (switchingProvider) {
                    try {
                        clientRef.current = buildClient(nextConfig);
                    }
                    catch (err) {
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
                setSession((prev) => prev ? { ...prev, provider: providerId, model: item.id } : prev);
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
        }
        else if (picker === 'variant') {
            const variant = VARIANTS[pickerIndex];
            if (variant) {
                setVariantId(variant.id);
                const nextSettings = { ...settings, variant: variant.id };
                setSettings(nextSettings);
                saveSettings(nextSettings);
            }
            setPicker(null);
        }
        else if (picker === 'provider') {
            const item = providerItems[pickerIndex];
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
        }
        else if (picker === 'session') {
            const item = sessionItems[pickerIndex];
            setPicker(null);
            setSessionItems([]);
            if (item)
                void switchSession(item.id);
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
    ]);
    const handleSubmit = useCallback(async (value) => {
        const trimmed = value.trim();
        if (!trimmed || loading || !clientRef.current || !config)
            return;
        // Handle slash commands — Enter runs the highlighted palette row.
        if (trimmed.startsWith('/')) {
            const selected = commandItems[commandIndex]?.label ?? trimmed.split(/\s+/)[0];
            const handled = await handleSlashCommand(selected, trimmed);
            if (handled) {
                setInputText('');
                setInputResetKey((prev) => prev + 1);
                return;
            }
        }
        setInputText('');
        setInputResetKey((prev) => prev + 1); // Force TextInput to remount and clear
        sessionSavedRef.current = false;
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
        // We still push it into completionMessages for session saving.
        const userMessage = { role: 'user', content: trimmed };
        printMessageToScrollback(addStatic, 'user', trimmed);
        setCompletionMessages((prev) => [...prev, userMessage]);
        // Reset assistant message tracker (streamed indices were reset above)
        assistantMessageRef.current = null;
        try {
            const pricing = getModelPricing(config.provider, config.model);
            const requestDefaults = getRequestDefaultParams(config.provider, config.model);
            const chosenVariant = VARIANTS.find((item) => item.id === variantId);
            if (chosenVariant?.reasoningEffort) {
                requestDefaults.reasoning_effort = chosenVariant.reasoningEffort;
            }
            else {
                // "none" must mean none, even when the model config has a default.
                delete requestDefaults.reasoning_effort;
            }
            // Create abort controller for this completion
            abortControllerRef.current = new AbortController();
            const updatedMessages = await runAgenticLoop(clientRef.current, config.model, [...completionMessages, userMessage], trimmed, handleAgentEvent, {
                pricing: pricing || undefined,
                abortSignal: abortControllerRef.current.signal,
                sessionId: session?.id,
                requestDefaults,
            });
            // A newer run (or /new) superseded this one: drop the result instead of
            // writing the old conversation into the current session.
            if (runId !== activeRunRef.current)
                return;
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
                await saveSession(session);
                sessionSavedRef.current = true;
            }
        }
        catch (err) {
            if (runId !== activeRunRef.current)
                return;
            setError(`Error: ${err.message}`);
        }
        finally {
            if (runId === activeRunRef.current) {
                setLoading(false);
            }
        }
    }, [loading, config, completionMessages, session, handleSlashCommand, addStatic, rows, commandItems, commandIndex, variantId, settings]);
    // Any command path can reject; never let that become an unhandled rejection
    // that kills the TUI after a turn.
    const submitSafely = useCallback(async (value) => {
        try {
            await handleSubmit(value);
        }
        catch (err) {
            setError(`Request failed: ${err.message}`);
            setLoading(false);
        }
    }, [handleSubmit]);
    const transcriptRows = staticItems.reduce((total, item) => total + (measuredHeights[item.id] ?? fallbackItemRows(item.node)), 0);
    const maxUserScroll = maxScrollOffset(transcriptRows, viewportRows);
    const effectiveUserScroll = clampScroll(userScroll, maxUserScroll);
    // Only the rows inside the viewport are rendered. Ink's negative marginTop
    // over-scrolls and snaps, which made scrolling lag and skip rows.
    // One row of the viewport is reserved for top breathing room so the first
    // message never touches the screen edge.
    const TOP_PAD = 1;
    const rowWindow = visibleRowWindow(transcriptRows, Math.max(1, viewportRows - TOP_PAD), effectiveUserScroll);
    // Map the row window onto measured items. Items below the viewport are
    // skipped entirely, so a long session stays cheap to render.
    const sizedItems = staticItems.map((item) => ({
        item,
        rows: measuredHeights[item.id] ?? fallbackItemRows(item.node),
    }));
    const windowSlice = sliceItemsToWindow(sizedItems.map((entry) => ({ id: entry.item.id, rows: entry.rows })), rowWindow.first, rowWindow.last);
    const visibleIds = new Set(windowSlice.items.map((entry) => entry.id));
    const visibleItems = staticItems.filter((item) => visibleIds.has(item.id));
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
    const scrollTo = useCallback((next) => {
        const clamped = clampScroll(next, scrollStateRef.current.maxUserScroll);
        scrollStateRef.current.userScroll = clamped;
        setUserScroll(clamped);
    }, []);
    const scrollBy = useCallback((amount) => {
        scrollTo(scrollStateRef.current.userScroll + amount);
    }, [scrollTo]);
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
        // API key prompt owns text input; only Esc (when idle) is handled here.
        if (keyPrompt) {
            if (key.escape && !keyPrompt.busy)
                setKeyPrompt(null);
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
            if (isMouseReport(input))
                return;
            // The model picker doubles as a search box.
            if (picker === 'model') {
                if (key.backspace || key.delete) {
                    setModelSearch((prev) => prev.slice(0, -1));
                    setPickerIndex(0);
                    return;
                }
                if (input.length > 0 &&
                    !key.ctrl &&
                    !key.meta &&
                    !key.escape &&
                    !key.tab &&
                    !key.return &&
                    !key.upArrow &&
                    !key.downArrow) {
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
                if (count > 0)
                    applyPicker();
                return;
            }
            if (key.escape) {
                modelFetchSeqRef.current += 1;
                setPicker(null);
                setPendingProviderId(null);
                setModelNotice(null);
                setModelSearch('');
                setModelsLoading(false);
                setSessionItems([]);
                setSessionsLoading(false);
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
            const blockHeight = thinkingBlockHeight(thinkingText, thinkingExpanded, columns, rows);
            if (press && isClickOnThinkingBlock(press.y, rows, blockHeight)) {
                thinkingPinnedRef.current = true;
                setThinkingExpanded((expanded) => !expanded);
            }
            return;
        }
        // Scroll the transcript without moving the input/footer. Arrows also work
        // when Termux sends them for touch swipes.
        if (!picker && settingsIndex === null && !pendingApproval && !(inputText.startsWith('/') && commandItems.length > 0)) {
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
        if (key.ctrl && input === 't') {
            if (thinkingText) {
                thinkingPinnedRef.current = true;
                setThinkingExpanded((expanded) => !expanded);
            }
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
    // Responsive breakpoints live in utils/layout.ts so every panel agrees.
    const layout = resolveLayout(columns, rows);
    const { paletteWindow, visibleTodos, gutter } = layout;
    const inputFocused = initialized && config !== null && picker === null && settingsIndex === null && keyPrompt === null;
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
    const area = splitLiveArea(frameHeight, {
        todos: todoRows,
        thinking: thinkingRows,
        help: helpRows,
        streaming: streamReserve,
    });
    const maxStreamRows = Math.max(1, area.transcriptRows);
    if (!screenReady)
        return null;
    // Rail geometry. `viewportRows` is measured from the real layout, so the
    // thumb lines up with what is actually on screen.
    const scrollbar = scrollbarGeometry(transcriptRows, viewportRows, effectiveUserScroll);
    const railLines = scrollbarLines(scrollbar);
    return (_jsxs(Box, { flexDirection: "column", height: frameHeight, children: [_jsxs(Box, { flexDirection: "row", flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 1, children: [_jsxs(Box, { ref: viewportRef, flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 1, overflow: "hidden", flexDirection: "column", children: [_jsx(Box, { height: TOP_PAD, flexShrink: 0 }), trimTop > 0 && _jsx(Box, { height: trimTop, flexShrink: 0 }), visibleItems.map((item) => (_jsx(StaticEntry, { item: item, columns: columns, onMeasure: handleMeasureItem }, item.id)))] }), railLines.length > 0 && (_jsx(Box, { flexDirection: "column", flexShrink: 0, width: 1, overflow: "hidden", children: railLines.map((line, index) => (_jsx(Text, { color: line === SCROLLBAR_THUMB ? theme.muted : theme.border, children: line }, index))) }))] }), _jsxs(Box, { flexDirection: "column", flexShrink: 0, children: [helpMessage && (_jsx(Box, { paddingX: 2, children: _jsx(LeftBar, { color: theme.muted, marginTop: 1, marginBottom: 1, children: _jsx(Text, { children: helpMessage }) }) })), !initialized && !error && _jsx(Text, { color: theme.dim, children: "Initializing..." }), initialized && !pendingApproval && (_jsx(TodoPanel, { todos: todos, columns: columns, maxVisible: visibleTodos })), hasThinkingBlock && !pendingApproval && (_jsx(ThinkingBlock, { text: thinkingText, expanded: thinkingExpanded, active: thinkingActive, animate: settings.animations, frame: spinnerFrame, columns: columns, rows: rows, elapsedMs: thinkingElapsedMs })), isStreaming && (_jsx(Box, { paddingX: gutter, paddingBottom: 1, children: _jsxs(Text, { wrap: "wrap", children: [renderFormattedText(clipToRows(streamingText, maxStreamRows)), _jsx(Text, { dimColor: true, children: "\u258D" })] }) })), threadErrors.filter((threadError) => threadError.transient).map((threadError) => (_jsx(Box, { paddingX: 2, children: _jsx(LeftBar, { color: theme.muted, marginBottom: 1, children: _jsx(Text, { color: theme.muted, children: threadError.message }) }) }, `thread-error-${threadError.id}`))), pendingAsk && !pendingApproval && (_jsx(AskPrompt, { questions: pendingAsk.request.questions, columns: columns, onRespond: (response) => {
                            pendingAsk.resolve(response);
                            setPendingAsk(null);
                        } })), pendingApproval && (_jsx(ApprovalPrompt, { request: pendingApproval.request, onRespond: (response) => {
                            pendingApproval.resolve(response);
                            setPendingApproval(null);
                        } })), keyPrompt && (_jsx(ApiKeyPrompt, { providerName: keyPrompt.providerName, path: keyPrompt.path, error: keyPrompt.error, busy: keyPrompt.busy, onSubmit: (value) => { void handleApiKeySubmit(value); } })), picker === 'model' && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { paddingX: 2, children: [_jsx(Text, { color: theme.dim, children: "Search " }), _jsx(Text, { color: theme.text, children: modelSearch }), _jsx(Text, { inverse: true, children: ' ' })] }), modelItems.length > 0 ? (_jsxs(_Fragment, { children: [(modelsLoading || modelNotice) && (_jsx(Box, { paddingX: 2, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: modelsLoading
                                                ? `Fetching models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
                                                : modelNotice }) })), _jsx(Palette, { title: modelProvider ? `Select model · ${modelProvider.name}` : 'Select model', items: modelItems, selected: selectedModelIndex, maxVisible: paletteWindow, hint: "type to search \u00B7 \u2191\u2193 select \u00B7 enter use \u00B7 esc cancel" })] })) : (_jsx(Box, { paddingX: 2, children: _jsx(Text, { color: modelsLoading ? theme.dim : theme.error, children: modelsLoading
                                        ? `Loading models${modelProvider ? ` · ${modelProvider.name}` : ''}…`
                                        : modelSearch.trim()
                                            ? `No models match "${modelSearch}".`
                                            : modelNotice ?? 'No models available.' }) }))] })), picker === 'provider' && (_jsx(Palette, { title: "Select provider", items: providerItems, selected: pickerIndex, maxVisible: paletteWindow, hint: "\u2191\u2193 select \u00B7 enter use \u00B7 esc cancel" })), picker === 'session' && (sessionItems.length > 0 ? (_jsx(Palette, { title: "Select session", items: sessionItems, selected: Math.min(pickerIndex, sessionItems.length - 1), maxVisible: paletteWindow, hint: "\u2191\u2193 select \u00B7 enter resume \u00B7 esc cancel" })) : (_jsx(Box, { paddingX: 2, children: _jsx(Text, { color: sessionsLoading ? theme.dim : theme.muted, children: sessionsLoading ? 'Loading sessions…' : 'No saved sessions. Press esc to close.' }) }))), picker === 'variant' && (_jsx(Palette, { title: "Select variant", items: variantItems, selected: pickerIndex, maxVisible: paletteWindow, hint: "\u2191\u2193 select \u00B7 enter use \u00B7 esc cancel" })), settingsIndex !== null && (_jsx(Palette, { title: "Settings", items: settingItems, selected: settingsIndex, maxVisible: paletteWindow, hint: "\u2191\u2193 select \u00B7 enter toggle \u00B7 esc close" })), !picker && !keyPrompt && settingsIndex === null && initialized && !pendingApproval && inputText.startsWith('/') && (_jsx(Palette, { items: commandItems, selected: commandIndex, maxVisible: paletteWindow }))] }), initialized && !pendingApproval && !pendingAsk && !keyPrompt && (_jsx(Box, { flexDirection: "column", alignItems: "center", children: _jsxs(Box, { flexDirection: "row", width: layout.inputWidth, backgroundColor: theme.surface, paddingY: 1, paddingLeft: 1, children: [_jsx(Box, { borderStyle: "bold", borderTop: false, borderRight: false, borderBottom: false, borderLeftColor: inputFocused ? theme.accent : theme.border, paddingRight: 1 }), _jsx(Box, { flexGrow: 1, minWidth: 8, paddingRight: 2, children: _jsx(PromptInput, { value: inputText, onChange: setInputText, onSubmit: submitSafely, isDisabled: !config || picker !== null || settingsIndex !== null || keyPrompt !== null, placeholder: config ? 'Build anything…' : 'Run: bitacode configure' }, inputResetKey) }), layout.showSubmitHint && (_jsx(Box, { paddingRight: 1, children: _jsx(Text, { color: theme.dim, children: '↵' }) }))] }) })), initialized && !pendingApproval && (_jsx(UsageDisplay, { usage: lastUsage ?? null, totalCost: totalCost, modelLabel: modelLabel, variantLabel: chosenVariant.label, variantColor: chosenVariant.color, folder: folderName, busy: loading, tool: activeTool, frame: spinnerFrame, compact: !layout.showFullFooter, gutter: gutter }))] }));
};

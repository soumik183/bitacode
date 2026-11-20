import React, { useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import type { AgentEvent, Message } from '../agentic-loop.js';
import { ThinkingArchive } from '../components/ThinkingArchive.js';
import { useTheme } from '../theme.js';
import type { Theme } from '../theme.js';
import { renderFormattedText, normalizeTranscriptText } from '../utils/format-message.js';
import { logger } from '../utils/logger.js';
import { formatSubAgentActivity } from '../utils/tool-display.js';
import { addToolResultView } from '../utils/tool-result-view.js';
import type { AddStaticFn } from '../utils/transcript.js';

export interface AssistantMessageRef {
  message: any;
  index: number;
  kind: 'streaming_text' | 'tool_call_assistant';
}

export interface StreamingBuffer {
  unflushedContent: string;
  hasFlushedAnyLine: boolean;
  lastUiUpdate: number;
}

// Cap live-frame re-renders on fast streams. With incremental rendering only
// the changed line is written, so a 60 fps cadence is smooth without the
// full-frame repaint cost that made the old 50 ms value necessary.
const STREAM_UI_INTERVAL_MS = 16;

export interface InlineThreadError {
  id: string;
  message: string;
  transient?: boolean;
}

interface UseAgentEventHandlerOptions {
  addStatic: AddStaticFn;
  setCompletionMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingText: React.Dispatch<React.SetStateAction<string>>;
  setThinkingText: React.Dispatch<React.SetStateAction<string>>;
  setThinkingArchived: React.Dispatch<React.SetStateAction<boolean>>;
  setThinkingStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
  reasoningRef: React.MutableRefObject<string>;
  setActiveTool: React.Dispatch<React.SetStateAction<string | null>>;
  setLastUsage: React.Dispatch<React.SetStateAction<AgentEvent['usage'] | null>>;
  setTotalCost: React.Dispatch<React.SetStateAction<number>>;
  setThreadErrors: React.Dispatch<React.SetStateAction<InlineThreadError[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  assistantMessageRef: React.MutableRefObject<AssistantMessageRef | null>;
  streamingBufferRef: React.MutableRefObject<StreamingBuffer>;
  /** Terminal width, forwarded to archived thinking previews. */
  columns?: number;
}

export function useAgentEventHandler(options: UseAgentEventHandlerOptions) {
  const theme = useTheme();
  const reasoningUiRef = useRef(0);
  const reasoningStartedRef = useRef(0);
  const {
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
  } = options;

  return useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'text_delta': {
        handleTextDelta(event as AgentEvent & { type: 'text_delta' }, {
          addStatic,
          palette: theme,
          setCompletionMessages,
          setIsStreaming,
          setStreamingText,
          setThinkingArchived,
          setThinkingStartedAt,
          setThinkingText,
          reasoningRef,
          reasoningStartedRef,
          columns,
          assistantMessageRef,
          streamingBufferRef,
        });
        break;
      }
      case 'reasoning_delta': {
        if (event.content) {
          if (!reasoningRef.current) {
            // A new reasoning phase: start its clock and show the live block.
            reasoningUiRef.current = 0;
            reasoningStartedRef.current = Date.now();
            setThinkingArchived(false);
            setThinkingStartedAt(reasoningStartedRef.current);
          }
          reasoningRef.current = (reasoningRef.current + event.content).slice(0, 20_000);
          const now = Date.now();
          if (
            reasoningUiRef.current === 0 ||
            now - reasoningUiRef.current >= STREAM_UI_INTERVAL_MS
          ) {
            reasoningUiRef.current = now;
            setThinkingText(reasoningRef.current);
          }
        }
        break;
      }
      case 'sub_agent_iteration': {
        handleSubAgentIteration(event as AgentEvent & { type: 'sub_agent_iteration' }, {
          setActiveTool,
          setTotalCost,
        });
        break;
      }
      case 'tool_call': {
        handleToolCall(event as AgentEvent & { type: 'tool_call' }, {
          addStatic,
          palette: theme,
          setCompletionMessages,
          setActiveTool,
          assistantMessageRef,
          streamingBufferRef,
          setIsStreaming,
          setStreamingText,
          setThinkingArchived,
          setThinkingStartedAt,
          setThinkingText,
          reasoningRef,
          reasoningStartedRef,
          columns,
        });
        break;
      }
      case 'tool_result': {
        handleToolResult(event as AgentEvent & { type: 'tool_result' }, {
          addStatic,
          setCompletionMessages,
          setActiveTool,
          assistantMessageRef,
          palette: theme,
        });
        break;
      }
      case 'usage': {
        handleUsage(event as AgentEvent & { type: 'usage' }, { setLastUsage, setTotalCost });
        break;
      }
      case 'error': {
        handleError(event as AgentEvent & { type: 'error' }, { setThreadErrors, setError });
        break;
      }
      case 'iteration_done': {
        handleIterationDone({ assistantMessageRef });
        break;
      }
      case 'done': {
        reasoningUiRef.current = 0;
        handleDone(event as AgentEvent & { type: 'done' }, {
          addStatic,
          palette: theme,
          setCompletionMessages,
          setIsStreaming,
          setStreamingText,
          setThinkingArchived,
          setThinkingStartedAt,
          setThinkingText,
          setActiveTool,
          setThreadErrors,
          reasoningRef,
          reasoningStartedRef,
          columns,
          assistantMessageRef,
          streamingBufferRef,
        });
        break;
      }
    }
  }, [
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
    theme,
  ]);
}

// Shared base interface for contexts that need static scrollback access
interface StaticContext {
  addStatic: AddStaticFn;
  /** Active palette, forwarded to pure helpers that paint palette colours. */
  palette: Theme;
  /** Terminal width, so archived markdown (tables!) is scaled to fit. */
  columns?: number;
}

interface ThinkingContext extends StaticContext {
  /** Terminal width, used to size the archived thought preview. */
  columns?: number;
  reasoningRef: React.MutableRefObject<string>;
  reasoningStartedRef: React.MutableRefObject<number>;
  setThinkingText: React.Dispatch<React.SetStateAction<string>>;
  setThinkingArchived: React.Dispatch<React.SetStateAction<boolean>>;
  setThinkingStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
}

/**
 * Move the current reasoning phase into scrollback and hide the live block.
 * Called before response text or tool output so the thought stays above what
 * it produced, instead of being duplicated below it when the turn ends.
 */
function archiveThinking(ctx: ThinkingContext): void {
  const reasoning = ctx.reasoningRef.current.trim();
  if (!reasoning) return;

  const elapsedMs = ctx.reasoningStartedRef.current > 0
    ? Date.now() - ctx.reasoningStartedRef.current
    : 0;
  const collapsed = <ThinkingArchive text={reasoning} elapsedMs={elapsedMs} columns={ctx.columns} />;
  const expanded = (
    <ThinkingArchive text={reasoning} elapsedMs={elapsedMs} columns={ctx.columns} expanded />
  );
  ctx.addStatic(collapsed, { collapsed, expanded });
  ctx.reasoningRef.current = '';
  ctx.reasoningStartedRef.current = 0;
  ctx.setThinkingText('');
  ctx.setThinkingArchived(true);
  ctx.setThinkingStartedAt(null);
}

// Shared base interface for contexts that need streaming state
interface StreamingContext extends StaticContext {
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingText: React.Dispatch<React.SetStateAction<string>>;
  assistantMessageRef: React.MutableRefObject<AssistantMessageRef | null>;
  streamingBufferRef: React.MutableRefObject<StreamingBuffer>;
}

/**
 * Width available to an archived reply: terminal minus the transcript gutter
 * and the scrollbar rail. `0` means "unconstrained", which the renderer treats
 * as the old behaviour, so callers without a measured width keep working.
 */
function transcriptWidth(columns?: number): number {
  if (!columns || !Number.isFinite(columns)) return 0;
  return Math.max(20, Math.floor(columns) - 5);
}

// Helper to flush streaming buffer to static and reset state
function flushStreamingBuffer(ctx: StreamingContext) {
  const { addStatic, setIsStreaming, setStreamingText, streamingBufferRef } = ctx;
  const buffer = streamingBufferRef.current;

  if (buffer.unflushedContent) {
    addStatic(
      <Box paddingX={2} paddingBottom={1}>
        <Text>{renderFormattedText(buffer.unflushedContent, transcriptWidth(ctx.columns), ctx.palette)}</Text>
      </Box>
    );
  }

  streamingBufferRef.current = { unflushedContent: '', hasFlushedAnyLine: false, lastUiUpdate: 0 };
  setIsStreaming(false);
  setStreamingText('');
}

interface TextDeltaContext extends StreamingContext, ThinkingContext {
  setCompletionMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

function handleTextDelta(
  event: AgentEvent & { type: 'text_delta' },
  ctx: TextDeltaContext
) {
  const deltaText = event.content || '';
  const { assistantMessageRef, streamingBufferRef, setCompletionMessages, setIsStreaming, setStreamingText } = ctx;

  // Reasoning comes before response text: archive it before the first chunk
  // so the scrollback order stays thought → answer.
  archiveThinking(ctx);

  // First text delta of this turn: initialize ref, show streaming indicator.
  if (!assistantMessageRef.current || assistantMessageRef.current.kind !== 'streaming_text') {
    // Trim leading whitespace from first delta - LLMs often output leading \n or spaces
    const trimmedDelta = deltaText.replace(/^\s+/, '');
    const assistantMsg = { role: 'assistant', content: trimmedDelta, tool_calls: [] } as Message;

    // Set the ref synchronously: a fast stream can emit `done` before React
    // runs the state updater below, and handleDone must see this message.
    assistantMessageRef.current = { message: assistantMsg, index: -1, kind: 'streaming_text' };

    // Use functional update to get correct index
    setCompletionMessages((prev) => {
      const idx = prev.length;
      if (assistantMessageRef.current?.message === assistantMsg) {
        assistantMessageRef.current.index = idx;
      }
      return [...prev, assistantMsg];
    });
    
    setIsStreaming(true);

    // The whole reply stays in the live area while it arrives and is rendered
    // as one formatted markdown block every frame, so headings, lists, tables
    // and code look right in real time instead of being split by flushes.
    streamingBufferRef.current = { unflushedContent: trimmedDelta, hasFlushedAnyLine: false, lastUiUpdate: Date.now() };
    setStreamingText(trimmedDelta);
  } else {
    assistantMessageRef.current.message.content += deltaText;

    const buffer = streamingBufferRef.current;
    buffer.unflushedContent += deltaText;

    // Throttle frame updates on a fast stream. The text itself is never split,
    // so what is on screen is always the current, fully formatted reply.
    const now = Date.now();
    if (now - buffer.lastUiUpdate >= STREAM_UI_INTERVAL_MS) {
      buffer.lastUiUpdate = now;
      setStreamingText(buffer.unflushedContent);
    }
  }
}

interface SubAgentIterationContext {
  setActiveTool: React.Dispatch<React.SetStateAction<string | null>>;
  setTotalCost: React.Dispatch<React.SetStateAction<number>>;
}

function handleSubAgentIteration(
  event: AgentEvent & { type: 'sub_agent_iteration' },
  ctx: SubAgentIterationContext
) {
  const { setActiveTool, setTotalCost } = ctx;
  
  if (event.subAgentTool) {
    const { tool, status, args } = event.subAgentTool;
    if (status === 'running') {
      setActiveTool(formatSubAgentActivity(tool, args));
    } else {
      setActiveTool(null);
    }
  }
  // Handle sub-agent usage update
  if (event.subAgentUsage) {
    setTotalCost((prev) => prev + event.subAgentUsage!.estimatedCost);
  }
}

interface ToolCallContext extends StreamingContext, ThinkingContext {
  setActiveTool: React.Dispatch<React.SetStateAction<string | null>>;
  setCompletionMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

function handleToolCall(
  event: AgentEvent & { type: 'tool_call' },
  ctx: ToolCallContext
) {
  const { setCompletionMessages, setActiveTool, assistantMessageRef } = ctx;
  
  if (!event.toolCall) return;
  
  // Reasoning precedes the tool call it decided to make.
  archiveThinking(ctx);
  
  const toolCall = event.toolCall;
  setActiveTool(toolCall.name);

  // If the model streamed some text before invoking this tool,
  // flush any remaining unflushed content to <Static> now.
  if (assistantMessageRef.current?.kind === 'streaming_text') {
    // Flush buffer and add spacing before the tool call
    flushStreamingBuffer(ctx);
    ctx.addStatic(<Box height={1} />);
    assistantMessageRef.current = null;
  }

  // Track the tool call in the ref WITHOUT triggering a render.
  // The render will happen when tool_result arrives.
  const existingRef = assistantMessageRef.current;
  const assistantMsg = existingRef?.message
    ? {
        ...existingRef.message,
        tool_calls: [...(existingRef.message.tool_calls || [])],
      }
    : { role: 'assistant', content: '', tool_calls: [] as any[] };

  const nextToolCall = {
    id: toolCall.id,
    type: 'function',
    function: { name: toolCall.name, arguments: toolCall.args },
  };

  const idx = assistantMsg.tool_calls.findIndex(
    (tc: any) => tc.id === toolCall.id
  );
  if (idx === -1) {
    assistantMsg.tool_calls.push(nextToolCall);
  } else {
    assistantMsg.tool_calls[idx] = nextToolCall;
  }

  if (!existingRef) {
    // First tool call — we need to add the assistant message to state.
    // Set the ref synchronously so a very fast tool result can still find it.
    const toolRef: AssistantMessageRef = {
      message: assistantMsg,
      index: -1,
      kind: 'tool_call_assistant',
    };
    assistantMessageRef.current = toolRef;
    setCompletionMessages((prev) => {
      if (assistantMessageRef.current === toolRef) {
        toolRef.index = prev.length;
      }
      return [...prev, assistantMsg as Message];
    });
  } else {
    // Subsequent tool calls — just update the ref, no render
    assistantMessageRef.current = {
      ...existingRef,
      message: assistantMsg,
      kind: 'tool_call_assistant',
    };
  }
}

interface ToolResultContext extends StaticContext {
  setCompletionMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setActiveTool: React.Dispatch<React.SetStateAction<string | null>>;
  assistantMessageRef: React.MutableRefObject<AssistantMessageRef | null>;
}

function handleToolResult(
  event: AgentEvent & { type: 'tool_result' },
  ctx: ToolResultContext
) {
  const { addStatic, setCompletionMessages, setActiveTool, assistantMessageRef, palette } = ctx;

  if (!event.toolCall) return;

  const toolCall = event.toolCall;
  setActiveTool(null);

  // Write the tool summary immediately — at this point loading is
  // still true but the frame height is stable (spinner + input box).
  // The next state change (setActiveTool(null)) doesn't affect
  // frame height so write() restores the correct frame.
  const rawResult = toolCall.result || '';
  try {
    addToolResultView(addStatic, toolCall.name, toolCall.args, rawResult, palette);
  } catch (err: any) {
    logger.warn('Could not render tool result', { error: err?.message ?? String(err) });
    addStatic(
      <Box paddingX={2} marginBottom={1}>
        <Text color={palette.error}>Could not display this tool result.</Text>
      </Box>
    );
  }

  // Flush the assistant message + tool result into completionMessages
  // for session saving.
  setCompletionMessages((prev) => {
    const updated = [...prev];
    // Sync assistant message; a fast tool result can arrive before the
    // state updater assigned its index, in which case the loop's final
    // message history is authoritative.
    const ref = assistantMessageRef.current;
    if (ref && ref.index >= 0 && ref.index < updated.length) {
      updated[ref.index] = { ...ref.message };
    }
    // Append tool result with args for replay
    updated.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: toolCall.result || '',
      name: toolCall.name,
      args: toolCall.args,
    } as any);
    return updated;
  });
}

interface UsageContext {
  setLastUsage: React.Dispatch<React.SetStateAction<AgentEvent['usage'] | null>>;
  setTotalCost: React.Dispatch<React.SetStateAction<number>>;
}

function handleUsage(
  event: AgentEvent & { type: 'usage' },
  ctx: UsageContext
) {
  const { setLastUsage, setTotalCost } = ctx;
  
  if (event.usage) {
    setLastUsage(event.usage);
    setTotalCost((prev) => prev + event.usage!.cost);
  }
}

interface ErrorContext {
  setThreadErrors: React.Dispatch<React.SetStateAction<InlineThreadError[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

function handleError(
  event: AgentEvent & { type: 'error' },
  ctx: ErrorContext
) {
  const { setThreadErrors, setError } = ctx;
  
  if (event.error) {
    const errorMessage = event.error;
    setThreadErrors((prev) => {
      if (event.transient) {
        return [
          ...prev.filter((threadError) => !threadError.transient),
          {
            id: `${Date.now()}-${prev.length}`,
            message: errorMessage,
            transient: true,
          },
        ];
      }

      if (prev[prev.length - 1]?.message === errorMessage) {
        return prev;
      }

      return [
        ...prev,
        {
          id: `${Date.now()}-${prev.length}`,
          message: errorMessage,
          transient: false,
        },
      ];
    });
  } else {
    setError('Unknown error');
  }
}

interface IterationDoneContext {
  assistantMessageRef: React.MutableRefObject<AssistantMessageRef | null>;
}

function handleIterationDone(ctx: IterationDoneContext) {
  const { assistantMessageRef } = ctx;
  
  if (assistantMessageRef.current?.kind === 'tool_call_assistant') {
    assistantMessageRef.current = null;
  }
}

interface DoneContext extends StreamingContext, ThinkingContext {
  setCompletionMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setActiveTool: React.Dispatch<React.SetStateAction<string | null>>;
  setThreadErrors: React.Dispatch<React.SetStateAction<InlineThreadError[]>>;
}

function handleDone(
  _event: AgentEvent & { type: 'done' },
  ctx: DoneContext
) {
  const { setCompletionMessages, setActiveTool, setThreadErrors, assistantMessageRef, streamingBufferRef } = ctx;

  // If no response text or tool call consumed the reasoning, archive it now
  // (before the final reply) so it is never left live or duplicated.
  archiveThinking(ctx);
  
  if (assistantMessageRef.current?.kind === 'streaming_text') {
    const finalRef = assistantMessageRef.current;

    // Archive the finished reply once, exactly as it was rendered live. Nothing
    // was written to scrollback during streaming, so there is no duplication and
    // no half-formatted block left above the live tail.
    const normalized = normalizeTranscriptText(finalRef.message.content || '');
    if (normalized) {
      ctx.addStatic(
        <Box paddingX={2} paddingBottom={1}>
          <Text>{renderFormattedText(normalized, transcriptWidth(ctx.columns), ctx.palette)}</Text>
        </Box>
      );
    }

    // Add final spacing after the streamed text so the reply does not sit
    // flush against the input or the next tool result.
    ctx.addStatic(<Box height={1} />);

    // Clear streaming state and buffer
    ctx.setIsStreaming(false);
    ctx.setStreamingText('');
    streamingBufferRef.current = { unflushedContent: '', hasFlushedAnyLine: false, lastUiUpdate: 0 };
    setCompletionMessages((prev) => {
      const updated = [...prev];
      if (finalRef.index >= 0 && finalRef.index < updated.length) {
        updated[finalRef.index] = { ...finalRef.message };
      }
      return updated;
    });
    assistantMessageRef.current = null;
  }
  setActiveTool(null);
  setThreadErrors((prev) => prev.filter((threadError) => !threadError.transient));
}

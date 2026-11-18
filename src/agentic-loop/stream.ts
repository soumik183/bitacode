/**
 * Stream processing module for the agentic loop.
 *
 * Handles accumulation of streaming response chunks into a complete
 * assistant message, including content, tool calls, and usage data.
 * Tolerates provider variance (alternate reasoning fields, tool-call
 * shapes, usage locations) and caps accumulation so a broken stream
 * cannot exhaust memory.
 */

import type OpenAI from 'openai';
import type { AgentEventHandler } from '../agentic-loop.js';
import { estimateTokens, estimateConversationTokens, createUsageInfo, getContextInfo, type ModelPricing } from '../utils/cost-tracker.js';
import { logger } from '../utils/logger.js';

/**
 * Accumulated result from processing a streaming response.
 */
export interface StreamResult {
  assistantMessage: {
    role: 'assistant';
    content: string;
    tool_calls: any[];
    /** UI-only field persisted for replaying the thought on resume. */
    reasoning?: string;
  };
  hasToolCalls: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    contextPercent: number;
  };
}

// Accumulation caps — a runaway or malformed stream must not grow without bound.
const MAX_REASONING_CHARS = 100_000;
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_TOOL_ARGS_CHARS = 100_000;

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Collect distinct reasoning fragments across common provider field names. */
function reasoningFragments(delta: any, chunk: any): string[] {
  const d = delta ?? {};
  const candidates = [
    asNonEmptyString(d.reasoning_content),
    asNonEmptyString(d.reasoning),
    asNonEmptyString(d.reasoning_text),
    asNonEmptyString(d.delta?.reasoning_content),
    asNonEmptyString(d.delta?.reasoning),
    asNonEmptyString(d.additional_kwargs?.reasoning_content),
    asNonEmptyString(chunk?.additional_kwargs?.reasoning_content),
  ];
  // Dedupe by value: a delta may repeat the same text under several names.
  return [...new Set(candidates.filter((c): c is string => c !== undefined))];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Normalize the usage shapes providers actually emit into CompletionUsage. */
function normalizeUsage(raw: any): OpenAI.CompletionUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const prompt = finiteNumber(raw.prompt_tokens) ?? finiteNumber(raw.input_tokens)
    ?? finiteNumber(raw.promptTokenCount) ?? finiteNumber(raw.inputTokens);
  const completion = finiteNumber(raw.completion_tokens) ?? finiteNumber(raw.output_tokens)
    ?? finiteNumber(raw.candidatesTokenCount) ?? finiteNumber(raw.outputTokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const cached = finiteNumber(raw.prompt_tokens_details?.cached_tokens)
    ?? finiteNumber(raw.cached_tokens) ?? finiteNumber(raw.cachedContentTokenCount)
    ?? finiteNumber(raw.cachedContentTokens);
  const total = finiteNumber(raw.total_tokens) ?? (prompt ?? 0) + (completion ?? 0);
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total,
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  } as unknown as OpenAI.CompletionUsage;
}

function extractUsage(chunk: any): OpenAI.CompletionUsage | undefined {
  return normalizeUsage(chunk?.usage)
    ?? normalizeUsage(chunk?.['x-usage'])
    ?? normalizeUsage(chunk?.usage_metadata)
    ?? normalizeUsage(chunk?.usageMetadata);
}

/** Normalize tool-call deltas to an array, accepting arrays or object maps. */
function toolCallEntries(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'object') return [];
  // A single tool-call object carries these keys directly; a map is keyed by index/id.
  if ('function' in raw || 'id' in raw || 'index' in raw) return [raw];
  return Object.entries(raw).map(([key, value], position) => {
    if (!value || typeof value !== 'object') return value;
    const tc = value as any;
    const numericKey = /^\d+$/.test(key) ? Number(key) : undefined;
    const index = Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : (numericKey ?? position);
    return { ...tc, index };
  });
}

/** Append arguments arriving as a string, a JSON object, or fragments. */
function appendArguments(current: string, fragment: unknown, hasName: boolean): string {
  if (current.length >= MAX_TOOL_ARGS_CHARS) return current;
  if (typeof fragment === 'string') {
    return (current + fragment).slice(0, MAX_TOOL_ARGS_CHARS);
  }
  if (fragment && typeof fragment === 'object') {
    // Object-form args only make sense on a well-formed call; malformed deltas
    // (e.g. a numeric name) are skipped rather than turned into garbage args.
    if (!hasName) return current;
    const parsed = parseObject(current);
    const next = parsed
      ? safeStringify({ ...parsed, ...(fragment as object) })
      : current + safeStringify(fragment);
    return next.slice(0, MAX_TOOL_ARGS_CHARS);
  }
  return current;
}

/**
 * Process a streaming API response, accumulating content and tool calls.
 *
 * Emits text_delta events for immediate UI display and usage info
 * when available. Returns the complete accumulated message.
 */
export async function processStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  messages: any[],
  model: string,
  pricing: ModelPricing | undefined,
  onEvent: AgentEventHandler
): Promise<StreamResult> {
  const assistantMessage = {
    role: 'assistant' as const,
    content: '',
    tool_calls: [] as any[],
  };

  let streamedContent = '';
  let streamedReasoning = '';
  let hasToolCalls = false;
  let actualUsage: OpenAI.CompletionUsage | undefined;
  let refusalEmitted = false;
  let truncationEmitted = false;
  let streamErrorEmitted = false;

  try {
    for await (const chunk of stream) {
      const c = chunk as any;
      const choice = c?.choices?.[0];
      const delta = choice?.delta;

      // Providers report usage under different keys; last non-empty one wins.
      const usage = extractUsage(c);
      if (usage) actualUsage = usage;

      // Surface a model refusal (delta.refusal with no text content) once so the
      // user knows why there was no answer.
      const refusal = delta?.refusal;
      if (!refusalEmitted && typeof refusal === 'string' && refusal.length > 0) {
        refusalEmitted = true;
        onEvent({ type: 'error', error: refusal, transient: true });
      }

      // Surface token-limit truncation once.
      if (!truncationEmitted && choice?.finish_reason === 'length') {
        truncationEmitted = true;
        onEvent({ type: 'error', error: "Response truncated by the model's token limit.", transient: true });
      }

      // Stream reasoning/thinking text across the field-name variants providers use.
      for (const fragment of reasoningFragments(delta, c)) {
        if (streamedReasoning.length < MAX_REASONING_CHARS) {
          streamedReasoning = (streamedReasoning + fragment).slice(0, MAX_REASONING_CHARS);
        }
        onEvent({ type: 'reasoning_delta', content: fragment });
      }

      // Stream text content (up to the cap) for immediate UI display.
      if (delta?.content) {
        const room = MAX_CONTENT_CHARS - streamedContent.length;
        if (room > 0) {
          const kept = (delta.content as string).slice(0, room);
          streamedContent += kept;
          assistantMessage.content = streamedContent;
          // Never emit plain text once tool calls have started.
          if (!hasToolCalls) {
            onEvent({ type: 'text_delta', content: kept });
          }
        }
      }

      // Accumulate tool calls across stream chunks (array or object map).
      const toolEntries = toolCallEntries(delta?.tool_calls);
      if (toolEntries.length > 0) hasToolCalls = true;
      for (const tc of toolEntries) {
        if (!tc || typeof tc !== 'object') continue;

        // Malformed deltas may carry a negative/fractional/missing index. For a
        // prefixed id, reuse a matching slot before falling back to slot 0.
        let idx = Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : -1;
        if (idx < 0 && typeof tc.id === 'string' && tc.id.length > 0) {
          const found = assistantMessage.tool_calls.findIndex((t: any) => t?.id === tc.id);
          idx = found >= 0 ? found : 0;
        }
        if (idx < 0) idx = 0;

        if (!assistantMessage.tool_calls[idx]) {
          assistantMessage.tool_calls[idx] = {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
        }
        const call = assistantMessage.tool_calls[idx];

        // Preserve provider ids verbatim (call_..., functions.xxx:0, ...).
        if (typeof tc.id === 'string' && tc.id.length > 0) call.id = tc.id;

        const fn = tc.function;
        if (fn && typeof fn === 'object') {
          if (typeof fn.name === 'string') {
            call.function.name += fn.name;
          }
          const hasName = typeof fn.name === 'string' || call.function.name.length > 0;
          if ('arguments' in fn) {
            call.function.arguments = appendArguments(call.function.arguments, fn.arguments, hasName);
          }
        }

        // Gemini 3+ includes an `extra_content.thought_signature` that MUST be
        // echoed back or Gemini rejects the next request with a 400.
        if (tc.extra_content) {
          call.extra_content = tc.extra_content;
        }
      }
    }
  } catch (err) {
    // A network error mid-stream must not discard what we already accumulated.
    if (!streamErrorEmitted) {
      streamErrorEmitted = true;
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', error: `Stream interrupted: ${message}`, transient: true });
    }
  }

  // Calculate usage metrics (estimated when the provider reported none).
  const inputTokens = actualUsage?.prompt_tokens ?? estimateConversationTokens(messages);
  const outputTokens = actualUsage?.completion_tokens ?? estimateTokens(assistantMessage.content || '');
  const cachedTokens = (actualUsage as any)?.prompt_tokens_details?.cached_tokens;
  const cost = pricing
    ? createUsageInfo(inputTokens, outputTokens, pricing, cachedTokens).estimatedCost
    : 0;
  const contextPercent = pricing
    ? getContextInfo(messages, pricing).utilizationPercentage
    : 0;

  if (!actualUsage) {
    logger.warn('Stream usage is partial (estimated); provider did not report usage.');
  }

  // Log API response with usage info at INFO level
  logger.info('Received API response', {
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cost: cost > 0 ? `$${cost.toFixed(4)}` : 'N/A',
    contextPercent: contextPercent > 0 ? `${contextPercent.toFixed(1)}%` : 'N/A',
    hasToolCalls: assistantMessage.tool_calls.length > 0,
    contentLength: assistantMessage.content?.length || 0,
    reasoningLength: streamedReasoning.length,
  });

  onEvent({
    type: 'usage',
    usage: { inputTokens, outputTokens, cost, contextPercent },
  });

  // Log the full assistant message for debugging
  logger.debug('Assistant response details', {
    contentLength: assistantMessage.content?.length || 0,
    contentPreview: assistantMessage.content?.slice(0, 200) || '(empty)',
    toolCallsCount: assistantMessage.tool_calls?.length || 0,
    toolCalls: assistantMessage.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      argsPreview: tc.function?.arguments?.slice(0, 100),
    })),
  });

  // Keep the reasoning with the assistant message so it survives session
  // save/replay. This is a UI-only field; the agentic loop strips it before
  // sending history back to the provider.
  if (streamedReasoning.trim()) {
    (assistantMessage as any).reasoning = streamedReasoning;
  }

  return {
    assistantMessage,
    hasToolCalls,
    usage: { inputTokens, outputTokens, cost, contextPercent },
  };
}

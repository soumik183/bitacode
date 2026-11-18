/**
 * Stream processing module for the agentic loop.
 *
 * Handles accumulation of streaming response chunks into a complete
 * assistant message, including content, tool calls, and usage data.
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

  // Cap accumulated reasoning so a runaway provider cannot exhaust memory.
  const MAX_REASONING_CHARS = 100_000;

  let streamedContent = '';
  let streamedReasoning = '';
  let hasToolCalls = false;
  let actualUsage: OpenAI.CompletionUsage | undefined;
  let refusalEmitted = false;
  let truncationEmitted = false;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    if (chunk.usage) {
      actualUsage = chunk.usage;
    }

    // Surface a model refusal (delta.refusal with no text content) once so the
    // user knows why there was no answer.
    const refusal = (delta as any)?.refusal;
    if (!refusalEmitted && typeof refusal === 'string' && refusal.length > 0) {
      refusalEmitted = true;
      onEvent({ type: 'error', error: refusal, transient: true });
    }

    // Surface token-limit truncation once.
    if (!truncationEmitted && chunk.choices[0]?.finish_reason === 'length') {
      truncationEmitted = true;
      onEvent({ type: 'error', error: "Response truncated by the model's token limit.", transient: true });
    }

    // Stream reasoning/thinking text when the provider exposes it
    // (`reasoning_content` for DeepSeek-style APIs, `reasoning` for others).
    const reasoningDelta = (delta as any)?.reasoning_content ?? (delta as any)?.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      if (streamedReasoning.length < MAX_REASONING_CHARS) {
        streamedReasoning = (streamedReasoning + reasoningDelta).slice(0, MAX_REASONING_CHARS);
      }
      onEvent({ type: 'reasoning_delta', content: reasoningDelta });
    }

    // Stream text content (and return to UI for immediate display via onEvent)
    if (delta?.content) {
      streamedContent += delta.content;
      assistantMessage.content = streamedContent;
      if (!hasToolCalls) {
        onEvent({ type: 'text_delta', content: delta.content });
      }
    }

    // Accumulate tool calls across stream chunks
    if (delta?.tool_calls) {
      hasToolCalls = true;
      for (const tc of delta.tool_calls) {
        // Malformed deltas may carry a negative/fractional index; fall back to slot 0.
        const idx = Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : 0;
        if (!assistantMessage.tool_calls[idx]) {
          assistantMessage.tool_calls[idx] = {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
        }
        if (tc.id) assistantMessage.tool_calls[idx].id = tc.id;
        if (typeof tc.function?.name === 'string') {
          assistantMessage.tool_calls[idx].function.name += tc.function.name;
        }
        if (typeof tc.function?.arguments === 'string') {
          assistantMessage.tool_calls[idx].function.arguments += tc.function.arguments;
        }
        // Gemini 3+ models include an `extra_content` field on tool calls
        // containing a `thought_signature`. This MUST be preserved and sent
        // back in subsequent requests, otherwise Gemini returns a 400.
        // See: https://ai.google.dev/gemini-api/docs/openai
        // See also: https://gist.github.com/thomasgauvin/3cfe8e907c957fba4e132e6cf0f06292
        if ((tc as any).extra_content) {
          assistantMessage.tool_calls[idx].extra_content = (tc as any).extra_content;
        }
      }
    }
  }

  // Calculate usage metrics
  const inputTokens = actualUsage?.prompt_tokens ?? estimateConversationTokens(messages);
  const outputTokens = actualUsage?.completion_tokens ?? estimateTokens(assistantMessage.content || '');
  const cachedTokens = (actualUsage as any)?.prompt_tokens_details?.cached_tokens;
  const cost = pricing
    ? createUsageInfo(inputTokens, outputTokens, pricing, cachedTokens).estimatedCost
    : 0;
  const contextPercent = pricing
    ? getContextInfo(messages, pricing).utilizationPercentage
    : 0;

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

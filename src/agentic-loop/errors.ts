// Error handling module for the agentic loop.
// Handles API errors with various retry strategies:
// - 400 errors: JSON repair, orphaned tool cleanup, truncation, "continue" prompts
// - 429 errors: rate limit backoff
// - 5xx errors: exponential backoff
// - Context window exceeded: forced compaction

import type { Message, AgentEventHandler } from '../agentic-loop.js';
import type { ModelPricing } from '../utils/cost-tracker.js';
import { compactIfNeeded } from '../utils/compactor.js';
import { logger } from '../utils/logger.js';

// Retry state tracked across loop iterations.
export interface RetryState {
  repairCount: number;
  contextCount: number;
  truncateCount: number;
  continueCount: number;
  retriggerCount: number; // For AI stopping after tool call
}

const LIMITS = {
  MAX_REPAIR: 2,
  MAX_CONTEXT: 2,
  MAX_TRUNCATE: 5,
  MAX_CONTINUE: 1,
};

// Sleep with abort signal support.
export async function sleepWithAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  if (abortSignal.aborted) {
    throw new Error('Operation aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      reject(new Error('Operation aborted'));
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

// Result of attempting to handle an API error.
export interface ErrorHandlerResult {
  handled: boolean;
  shouldAbort: boolean;
  silentRetry: boolean;
  errorMessage?: string;
  transient?: boolean;
}

// Handle an API error with appropriate retry strategy.
export async function handleApiError(
  apiError: any,
  messages: Message[],
  validToolNames: Set<string>,
  pricing: ModelPricing | undefined,
  retryState: RetryState,
  iterationCount: number,
  onEvent: AgentEventHandler,
  client?: any,
  model?: string,
  requestDefaults?: Record<string, unknown>,
  sessionId?: string,
  abortSignal?: AbortSignal,
  // Injectable for tests; production always uses the abort-aware default.
  sleepFn: (delayMs: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort
): Promise<ErrorHandlerResult> {
  const errMsg = apiError?.message || 'Unknown API error';
  const status = apiError?.status;

  logger.error(`API error: ${errMsg}`, { status, code: apiError?.code });

  const retryableStatus = status === 408 || status === 409 || status === 425;
  const retryableCode = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(apiError?.code);

  // Context window exceeded - force compaction (check before generic 400 handling).
  // 413 (payload too large) is the same condition reported by some providers.
  const isContextTooLong =
    status === 413 ||
    (status === 400 && /prompt.*too long|context.*length|maximum.*token|tokens?.*exceed/i.test(errMsg));

  if (isContextTooLong && retryState.contextCount < LIMITS.MAX_CONTEXT) {
    retryState.contextCount++;
    logger.warn(`Prompt too long (attempt ${retryState.contextCount})`);
    onEvent({
      type: 'error',
      error: 'Prompt too long. Compacting conversation...',
      transient: true,
    });

    if (pricing && client && model) {
      try {
        const compacted = await compactIfNeeded(
          client,
          model,
          messages,
          pricing.contextWindow,
          requestDefaults || {},
          sessionId
        );
        messages.length = 0;
        messages.push(...compacted);
      } catch (compactErr) {
        logger.error(`Compaction failed: ${compactErr}`);
      }
    }

    // Truncate oversized tool results as fallback
    const MAX_TOOL_CHARS = 20_000;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i] as any;
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MAX_TOOL_CHARS) {
        messages[i] = {
          ...m,
          content: m.content.slice(0, MAX_TOOL_CHARS) + '\n... (truncated)',
        };
      }
    }

    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // Rate limit - backoff
  if (status === 429) {
    const backoff = parseRetryAfterMs(apiError?.headers);
    logger.info(`Rate limited, retrying in ${backoff / 1000}s...`);
    onEvent({ type: 'error', error: `Rate limited. Retrying...`, transient: true });
    try {
      await sleepFn(backoff, abortSignal);
    } catch {
      return { handled: true, shouldAbort: true, silentRetry: false };
    }
    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // Server error - exponential backoff
  if (status >= 500 || retryableStatus || retryableCode) {
    const backoff = Math.min(2 ** iterationCount * 1000, 30_000);
    logger.info(`Request failed, retrying in ${backoff / 1000}s...`);
    onEvent({ type: 'error', error: `Request failed. Retrying...`, transient: true });
    try {
      await sleepFn(backoff, abortSignal);
    } catch {
      return { handled: true, shouldAbort: true, silentRetry: false };
    }
    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // Generic 400 errors - try repair/truncate/continue
  if (status === 400) {
    return await handle400Error(messages, validToolNames, retryState, onEvent);
  }

  // Non-retryable - short, user-facing messages; never leak raw response bodies.
  if (status === 401 || status === 403) {
    return {
      handled: false,
      shouldAbort: false,
      silentRetry: false,
      errorMessage: 'Authentication failed. Check your API key and try again.',
    };
  }
  if (status === 404) {
    return {
      handled: false,
      shouldAbort: false,
      silentRetry: false,
      errorMessage: 'Model or endpoint not found. Check your model configuration.',
    };
  }
  if (status === 413) {
    return {
      handled: false,
      shouldAbort: false,
      silentRetry: false,
      errorMessage: 'Request too large. Try /clear or a shorter input.',
    };
  }
  return {
    handled: false,
    shouldAbort: false,
    silentRetry: false,
    errorMessage: safeErrorMessage(errMsg, status),
  };
}

// Handle 400 errors: repair JSON → remove orphaned → truncate → continue.
async function handle400Error(
  messages: Message[],
  validToolNames: Set<string>,
  retryState: RetryState,
  onEvent: AgentEventHandler
): Promise<ErrorHandlerResult> {
  // 1. Try JSON repairs on tool arguments
  // Models sometimes emit invalid escape sequences in tool args (e.g., \| from grep regex)
  // which cause JSON.parse to fail. These persist across requests unless repaired.
  if (retryState.repairCount < LIMITS.MAX_REPAIR) {
    let repaired = false;

    for (const msg of messages) {
      const msgAny = msg as any;
      if (msg.role === 'assistant' && Array.isArray(msgAny.tool_calls)) {
        for (const tc of msgAny.tool_calls) {
          const args = tc.function?.arguments;
          if (args && typeof args === 'string') {
            const fixed = repairInvalidEscapes(args);
            if (fixed !== args) {
              tc.function.arguments = fixed;
              repaired = true;
            }
          }
        }
      }
    }

    if (repaired) {
      retryState.repairCount++;
      logger.warn('400 response: repaired invalid JSON escapes');
      return { handled: true, shouldAbort: false, silentRetry: true };
    }
  }

  // 2. Remove hallucinated tool calls + orphaned tool results
  // Models sometimes invent tool names; the API rejects the whole request until
  // those calls (and their results) are gone. Orphaned results have the same effect.
  const invalid = removeInvalidToolCalls(messages, validToolNames);
  const cleaned = removeOrphanedToolResults(invalid.messages);
  if (invalid.removed.length > 0 || cleaned.changed) {
    messages.length = 0;
    messages.push(...cleaned.messages);
    if (invalid.removed.length > 0) {
      logger.warn('400 response: removed hallucinated tool calls', { names: invalid.removed });
    }
    if (cleaned.changed) {
      logger.warn('400 response: removed orphaned tool results');
    }
    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // 3. Truncate messages progressively
  // If repairs didn't work, remove the last message (usually the problematic one)
  // and retry. We keep at least system + 1 user message.
  if (retryState.truncateCount < LIMITS.MAX_TRUNCATE && messages.length > 2) {
    retryState.truncateCount++;
    const removed = messages.splice(-1);
    logger.debug('400 error: removed last message', {
      role: removed[0]?.role,
      remaining: messages.length,
    });
    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // 4. Try "continue" prompt
  // Sometimes the model just needs a nudge to continue after getting stuck.
  if (retryState.continueCount < LIMITS.MAX_CONTINUE) {
    retryState.continueCount++;
    messages.push({ role: 'user', content: 'continue' } as Message);
    logger.warn('400 error: adding "continue" message');
    onEvent({ type: 'error', error: 'Retrying with "continue"...', transient: true });
    return { handled: true, shouldAbort: false, silentRetry: true };
  }

  // All strategies exhausted
  return {
    handled: false,
    shouldAbort: false,
    silentRetry: false,
    errorMessage: 'Could not recover from error. Try /clear to start fresh.',
  };
}

// Repair invalid JSON escape sequences.
// Models sometimes emit \| \! \- etc. (e.g. grep regex args).
function repairInvalidEscapes(value: string): string {
  return value.replace(/\\([^"/bfnrtu])/g, '\\\\$1');
}

// Remove orphaned tool result messages that don't have a matching tool_call_id.
function removeOrphanedToolResults(messages: Message[]): { messages: Message[]; changed: boolean } {
  const validToolCallIds = new Set<string>();

  for (const msg of messages) {
    const msgAny = msg as any;
    if (msg.role === 'assistant' && Array.isArray(msgAny.tool_calls)) {
      for (const tc of msgAny.tool_calls) {
        if (tc.id) validToolCallIds.add(tc.id);
      }
    }
  }

  const filtered = messages.filter((msg) => {
    const msgAny = msg as any;
    if (msg.role === 'tool' && msgAny.tool_call_id) {
      const isOrphaned = !validToolCallIds.has(msgAny.tool_call_id);
      if (isOrphaned) {
        logger.warn('Removing orphaned tool result', { id: msgAny.tool_call_id });
      }
      return !isOrphaned;
    }
    return true;
  });

  return { messages: filtered, changed: filtered.length !== messages.length };
}

// Parse Retry-After per RFC 7231: delta-seconds or an HTTP date.
// Always returns a finite number of milliseconds clamped to 1-60s.
function parseRetryAfterMs(headers: unknown): number {
  if (!headers) return 5_000;
  const headerObj = headers as { get?: (name: string) => unknown; [key: string]: unknown };
  // OpenAI SDK errors expose a Headers instance; hand-rolled clients use a plain object.
  const value = typeof headerObj.get === 'function'
    ? headerObj.get('retry-after')
    : headerObj['retry-after'];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return 5_000;

  const str = String(raw).trim();
  if (!str) return 5_000;

  let seconds: number;
  if (/^-?\d+(?:\.\d+)?$/.test(str)) {
    seconds = Number(str);
  } else {
    const parsed = Date.parse(str);
    if (Number.isNaN(parsed)) return 5_000;
    seconds = (parsed - Date.now()) / 1000;
  }

  if (!Number.isFinite(seconds) || seconds < 1) seconds = 1;
  if (seconds > 60) seconds = 60;
  return seconds * 1000;
}

// Keep error messages short and user-facing; never echo raw response bodies.
function safeErrorMessage(errMsg: unknown, status: number | undefined): string {
  const fallback = status ? `Request failed (status ${status}).` : 'Request failed.';
  if (typeof errMsg !== 'string') return fallback;

  const text = errMsg.replace(/\s+/g, ' ').trim();
  const singleLine = text.startsWith('{') || text.startsWith('[')
    ? 'Unexpected response from provider.'
    : text;
  const short = singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
  return status ? `${short} (status ${status})` : short;
}

// Drop tool calls whose function name isn't a registered tool, plus their results.
// Guards against an empty registry (would drop everything) and never strips the
// system prompt or the last user message.
function removeInvalidToolCalls(
  messages: Message[],
  validToolNames: Set<string>
): { messages: Message[]; removed: string[] } {
  if (validToolNames.size === 0) return { messages, removed: [] };

  const removedIds = new Set<string>();
  const removedNames = new Set<string>();
  const keptMessages: Message[] = [];

  for (const msg of messages) {
    const msgAny = msg as any;
    if (msg.role === 'assistant' && Array.isArray(msgAny.tool_calls)) {
      const kept = msgAny.tool_calls.filter((tc: any) => {
        const name = tc?.function?.name;
        if (!name || !validToolNames.has(name)) {
          removedNames.add(name || '(unnamed)');
          if (tc?.id) removedIds.add(tc.id);
          return false;
        }
        return true;
      });
      if (kept.length === msgAny.tool_calls.length) {
        keptMessages.push(msg);
        continue;
      }
      const hasContent =
        (typeof msgAny.content === 'string' && msgAny.content.trim().length > 0) ||
        (Array.isArray(msgAny.content) && msgAny.content.length > 0);
      if (hasContent || kept.length > 0) {
        keptMessages.push({ ...msg, tool_calls: kept } as Message);
      }
      continue;
    }
    keptMessages.push(msg);
  }

  if (removedIds.size === 0) return { messages, removed: [] };

  const result = keptMessages.filter((msg) => {
    const msgAny = msg as any;
    return !(msg.role === 'tool' && msgAny.tool_call_id && removedIds.has(msgAny.tool_call_id));
  });

  if (!result.some((m) => m.role === 'system') || !result.some((m) => m.role === 'user')) {
    return { messages, removed: [] };
  }

  return { messages: result, removed: [...removedNames] };
}

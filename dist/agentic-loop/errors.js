// Error handling module for the agentic loop.
// Handles API errors with various retry strategies:
// - 400 errors: JSON repair, orphaned tool cleanup, truncation, "continue" prompts
// - 429 errors: rate limit backoff
// - 5xx errors: exponential backoff
// - Context window exceeded: forced compaction
import { compactIfNeeded } from '../utils/compactor.js';
import { logger } from '../utils/logger.js';
import { sanitizeMessagesForProvider } from '../utils/message-sanitize.js';
const LIMITS = {
    MAX_REPAIR: 2,
    MAX_CONTEXT: 2,
    MAX_TRUNCATE: 5,
    MAX_CONTINUE: 1,
    MAX_SANITIZE: 1,
};
/**
 * Backoff schedule for transient failures: dropped connections, provider 5xx,
 * and rate limits that arrive without a usable Retry-After hint. Five retries
 * means six attempts in total; after that the loop stops with a clear message
 * instead of hammering the endpoint forever.
 */
export const TRANSIENT_BACKOFF_MS = [1_000, 3_000, 5_000, 10_000, 15_000];
export const MAX_TRANSIENT_RETRIES = TRANSIENT_BACKOFF_MS.length;
export const MAX_TRANSIENT_ATTEMPTS = MAX_TRANSIENT_RETRIES + 1;
// Providers and proxies disagree on status codes, so classify by message too.
// These only match error text, never response bodies (those stay redacted).
const AUTH_ERROR_PATTERN = /invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication[_\s-]?error|unauthorized|permission[_\s-]?denied|access denied|forbidden|no auth credentials|expired (api )?(key|token)|invalid token/i;
const RATE_ERROR_PATTERN = /rate[_\s-]?limit|too many requests|quota|resource[_\s-]?exhausted|usage limit|throttl|slow down/i;
const CONTEXT_ERROR_PATTERN = /maximum context length|context[_\s-]?(length|window)|input too long|prompt too long|token limit|maximum tokens?|too many tokens|tokens? exceed|string too long|request too large/i;
const RETRYABLE_CODES = new Set([
    'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNDOWN',
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT',
    'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EAI_AGAIN',
    'ENOTFOUND', 'EPIPE', 'ERR_NETWORK',
]);
// Sleep with abort signal support.
export async function sleepWithAbort(delayMs, abortSignal) {
    if (!abortSignal) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return;
    }
    if (abortSignal.aborted) {
        throw new Error('Operation aborted');
    }
    await new Promise((resolve, reject) => {
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
/**
 * Books one retry against the shared transient budget and returns the delay to
 * wait. Every transient path (rate limit, 5xx, dropped socket) draws from the
 * same counter, so a flapping provider cannot cause an endless retry storm by
 * alternating failure kinds.
 */
function planTransientRetry(retryState, reason, retryAfterMs) {
    const attempt = (retryState.transientCount ?? 0) + 1;
    if (attempt > MAX_TRANSIENT_RETRIES) {
        return {
            retry: false,
            errorMessage: `Gave up after ${MAX_TRANSIENT_ATTEMPTS} attempts: the provider kept failing `
                + `(${reason === 'rate' ? 'rate limited' : 'server or network error'}).`,
        };
    }
    retryState.transientCount = attempt;
    const scheduled = TRANSIENT_BACKOFF_MS[Math.min(attempt, MAX_TRANSIENT_RETRIES) - 1];
    // A provider-supplied Retry-After always wins when it asks for a longer wait.
    const delayMs = retryAfterMs !== null && retryAfterMs > scheduled ? retryAfterMs : scheduled;
    return { retry: true, delayMs, attempt };
}
// Handle an API error with appropriate retry strategy.
export async function handleApiError(apiError, messages, validToolNames, pricing, retryState, iterationCount, onEvent, client, model, requestDefaults, sessionId, abortSignal, 
// Injectable for tests; production always uses the abort-aware default.
sleepFn = sleepWithAbort, 
// Original user turn, used to rebuild a history that a repair step emptied.
fallbackUserContent) {
    const errMsg = apiError?.message || 'Unknown API error';
    const status = apiError?.status;
    const msg = typeof errMsg === 'string' ? errMsg : '';
    logger.error(`API error: ${errMsg}`, { status, code: apiError?.code });
    const authMessage = AUTH_ERROR_PATTERN.test(msg);
    const rateMessage = RATE_ERROR_PATTERN.test(msg);
    const contextMessage = CONTEXT_ERROR_PATTERN.test(msg);
    const retryableStatus = status === 408 || status === 409 || status === 425;
    const retryableCode = typeof apiError?.code === 'string' && RETRYABLE_CODES.has(apiError.code);
    // Auth by message wins first (proxies return 400/403 for key errors).
    if (authMessage) {
        return {
            handled: false,
            shouldAbort: false,
            silentRetry: false,
            errorMessage: 'Authentication failed. Check your API key or credentials.',
        };
    }
    // Context window exceeded - force compaction (before generic 400 handling).
    // 413 (payload too large) is the same condition reported by some providers.
    const isContextTooLong = contextMessage || status === 413 ||
        (status === 400 && /prompt.*too long|context.*length|maximum.*token|tokens?.*exceed/i.test(msg));
    if (isContextTooLong) {
        if (retryState.contextCount >= LIMITS.MAX_CONTEXT) {
            return {
                handled: false,
                shouldAbort: false,
                silentRetry: false,
                errorMessage: 'Conversation is too long. Try /clear or a shorter input.',
            };
        }
        retryState.contextCount++;
        logger.warn(`Prompt too long (attempt ${retryState.contextCount})`);
        onEvent({
            type: 'error',
            error: 'Prompt too long. Compacting conversation...',
            transient: true,
        });
        if (pricing && client && model) {
            try {
                const compacted = await compactIfNeeded(client, model, messages, pricing.contextWindow, requestDefaults || {}, sessionId);
                messages.length = 0;
                messages.push(...compacted);
            }
            catch (compactErr) {
                logger.error(`Compaction failed: ${compactErr}`);
            }
        }
        // Truncate oversized tool results as fallback
        const MAX_TOOL_CHARS = 20_000;
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MAX_TOOL_CHARS) {
                messages[i] = {
                    ...m,
                    content: m.content.slice(0, MAX_TOOL_CHARS) + '\n... (truncated)',
                };
            }
        }
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // Rate limit - backoff (some proxies report quota exhaustion with other statuses)
    if (rateMessage || status === 429) {
        const plan = planTransientRetry(retryState, 'rate', parseRetryAfterMs(apiError?.headers));
        if (!plan.retry) {
            return { handled: false, shouldAbort: false, silentRetry: false, errorMessage: plan.errorMessage };
        }
        logger.info(`Rate limited, retrying in ${plan.delayMs / 1000}s (attempt ${plan.attempt}/${MAX_TRANSIENT_RETRIES})`);
        onEvent({
            type: 'error',
            error: `Rate limited. Retrying in ${Math.round(plan.delayMs / 1000)}s (attempt ${plan.attempt}/${MAX_TRANSIENT_RETRIES})...`,
            transient: true,
        });
        try {
            await sleepFn(plan.delayMs, abortSignal);
        }
        catch {
            return { handled: true, shouldAbort: true, silentRetry: false };
        }
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // Server or network error - scheduled backoff
    if ((status !== undefined && status >= 500) || retryableStatus || retryableCode) {
        const plan = planTransientRetry(retryState, 'server', null);
        if (!plan.retry) {
            return { handled: false, shouldAbort: false, silentRetry: false, errorMessage: plan.errorMessage };
        }
        logger.info(`Request failed, retrying in ${plan.delayMs / 1000}s (attempt ${plan.attempt}/${MAX_TRANSIENT_RETRIES})`);
        onEvent({
            type: 'error',
            error: `Request failed. Retrying in ${Math.round(plan.delayMs / 1000)}s (attempt ${plan.attempt}/${MAX_TRANSIENT_RETRIES})...`,
            transient: true,
        });
        try {
            await sleepFn(plan.delayMs, abortSignal);
        }
        catch {
            return { handled: true, shouldAbort: true, silentRetry: false };
        }
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // Auth by status (non-auth quota/context messages were handled above).
    if (status === 401 || status === 403) {
        return {
            handled: false,
            shouldAbort: false,
            silentRetry: false,
            errorMessage: 'Authentication failed. Check your API key or credentials.',
        };
    }
    // Generic 400 errors - try repair/truncate/continue
    if (status === 400) {
        return await handle400Error(messages, validToolNames, retryState, onEvent, shortErrorReason(errMsg), fallbackUserContent);
    }
    // Non-retryable - short, user-facing messages; never leak raw response bodies.
    if (status === 404) {
        return {
            handled: false,
            shouldAbort: false,
            silentRetry: false,
            errorMessage: 'Model or endpoint not found. Check your model configuration.',
        };
    }
    return {
        handled: false,
        shouldAbort: false,
        silentRetry: false,
        errorMessage: safeErrorMessage(errMsg, status),
    };
}
// Handle 400 errors: repair tool calls → remove orphaned → truncate → continue → sanitize.
/**
 * Providers answer this when the body has no usable conversation: the request
 * reached them with `messages: []`. It is not a model or config problem, so the
 * generic "repair / truncate / continue" ladder cannot fix it.
 */
const EMPTY_HISTORY_PATTERN = /input required|specify[^.]*(prompt|messages)|messages[^.]*(required|non-empty|must be)|no messages|empty messages/i;
/** True when `messages` still has something a provider will accept. */
function hasPayload(messages) {
    return messages.some((message) => message.role !== 'system');
}
async function handle400Error(messages, validToolNames, retryState, onEvent, reason, fallbackUserContent) {
    // 0. Empty/unusable history — reseed instead of burning the repair ladder.
    // This is the failure that surfaced as `400 Input required: specify "prompt"
    // or "messages"` and ended the turn with "Could not recover".
    if (!hasPayload(messages) || (EMPTY_HISTORY_PATTERN.test(reason) && messages.length <= 1)) {
        const system = messages.find((message) => message.role === 'system');
        const fallback = typeof fallbackUserContent === 'string' ? fallbackUserContent.trim() : '';
        messages.length = 0;
        if (system)
            messages.push(system);
        messages.push({ role: 'user', content: fallback || 'continue' });
        logger.warn('400 response: restored an empty conversation history');
        onEvent({
            type: 'error',
            error: 'Conversation history was empty. Restored the last request.',
            transient: true,
        });
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // 1. Repair tool-call structure and arguments.
    // Models emit invalid escapes (\| from grep regex), unquoted arguments,
    // duplicate ids and empty assistant messages — all rejected until fixed.
    if (retryState.repairCount < LIMITS.MAX_REPAIR) {
        const repaired = repairMessagesFor400(messages);
        if (repaired) {
            retryState.repairCount++;
            logger.warn('400 response: repaired tool calls and message structure');
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
        // Remove the last *assistant/tool* exchange, never the user's request: a
        // history that ends with a tool result and no assistant message is one of
        // the shapes providers reject.
        let index = messages.length - 1;
        while (index > 1 && messages[index].role === 'tool')
            index--;
        if (index <= 1 || messages[index].role === 'user') {
            index = messages.length - 1;
        }
        retryState.truncateCount++;
        const removed = messages.splice(index, messages.length - index);
        logger.debug('400 error: removed trailing messages', {
            roles: removed.map((message) => message.role).join(','),
            remaining: messages.length,
        });
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // 4. Try "continue" prompt
    // Sometimes the model just needs a nudge to continue after getting stuck.
    if (retryState.continueCount < LIMITS.MAX_CONTINUE) {
        retryState.continueCount++;
        messages.push({ role: 'user', content: 'continue' });
        logger.warn('400 error: adding "continue" message');
        onEvent({ type: 'error', error: 'Retrying with "continue"...', transient: true });
        return { handled: true, shouldAbort: false, silentRetry: true };
    }
    // 5. Final defense: strip UI-only fields and structurally invalid messages.
    // The sanitizer returns the original array by identity when it changes nothing.
    if ((retryState.sanitizeCount ?? 0) < LIMITS.MAX_SANITIZE) {
        const sanitized = sanitizeMessagesForProvider(messages);
        if (sanitized !== messages) {
            retryState.sanitizeCount = (retryState.sanitizeCount ?? 0) + 1;
            messages.length = 0;
            messages.push(...sanitized);
            logger.warn('400 response: removed provider-unsafe message fields');
            onEvent({ type: 'error', error: 'Retrying with sanitized messages...', transient: true });
            return { handled: true, shouldAbort: false, silentRetry: true };
        }
    }
    // All strategies exhausted — keep the phrase tests rely on, but tell the
    // user what the provider actually complained about (redacted, one line).
    return {
        handled: false,
        shouldAbort: false,
        silentRetry: false,
        errorMessage: `Could not recover: ${reason}. ` +
            'The conversation may be malformed. Press ctrl+r to retry, or /new to start fresh.',
    };
}
// Repair tool calls and message structure that providers reject on sight.
function repairMessagesFor400(messages) {
    let repaired = false;
    for (const msg of messages) {
        const msgAny = msg;
        if (msg.role !== 'assistant' || !Array.isArray(msgAny.tool_calls))
            continue;
        // Drop malformed calls and duplicate ids (keep the first).
        const seen = new Set();
        const kept = msgAny.tool_calls.filter((tc) => {
            if (!tc || typeof tc !== 'object') {
                repaired = true;
                return false;
            }
            const id = tc.id;
            if (typeof id === 'string' && id.length > 0) {
                if (seen.has(id)) {
                    repaired = true;
                    return false;
                }
                seen.add(id);
            }
            if (!tc.function || typeof tc.function.name !== 'string' || !tc.function.name) {
                repaired = true;
                return false;
            }
            return true;
        });
        if (kept.length !== msgAny.tool_calls.length) {
            msgAny.tool_calls = kept;
        }
        for (const tc of kept) {
            const args = tc.function?.arguments;
            if (typeof args !== 'string') {
                tc.function.arguments = '{}';
                repaired = true;
                continue;
            }
            const fixed = repairToolArguments(args);
            if (fixed !== args) {
                tc.function.arguments = fixed;
                repaired = true;
            }
        }
    }
    // Keep only the first result per tool_call_id; duplicates break providers.
    const resultIds = new Set();
    const deduped = [];
    for (const msg of messages) {
        const msgAny = msg;
        if (msg.role === 'tool' && typeof msgAny.tool_call_id === 'string') {
            if (resultIds.has(msgAny.tool_call_id)) {
                repaired = true;
                continue;
            }
            resultIds.add(msgAny.tool_call_id);
        }
        deduped.push(msg);
    }
    if (deduped.length !== messages.length) {
        messages.length = 0;
        messages.push(...deduped);
    }
    // An assistant message with no text and no tool calls is invalid history.
    const nonEmpty = messages.filter((msg) => {
        const msgAny = msg;
        if (msg.role !== 'assistant')
            return true;
        const hasContent = (typeof msgAny.content === 'string' && msgAny.content.trim().length > 0) ||
            (Array.isArray(msgAny.content) && msgAny.content.length > 0);
        const hasCalls = Array.isArray(msgAny.tool_calls) && msgAny.tool_calls.length > 0;
        if (!hasContent && !hasCalls) {
            repaired = true;
            return false;
        }
        return true;
    });
    if (nonEmpty.length !== messages.length) {
        messages.length = 0;
        messages.push(...nonEmpty);
    }
    return repaired;
}
// Repair invalid JSON escape sequences.
// Models sometimes emit \| \! \- etc. (e.g. grep regex args).
function repairInvalidEscapes(value) {
    return value.replace(/\\([^"/bfnrtu])/g, '\\\\$1');
}
function isJson(value) {
    try {
        JSON.parse(value);
        return true;
    }
    catch {
        return false;
    }
}
// Make tool arguments a valid JSON string: fix escapes, then quote bare
// scalars, then fall back to '{}' rather than sending malformed JSON.
function repairToolArguments(args) {
    if (isJson(args))
        return args;
    const escaped = repairInvalidEscapes(args);
    if (isJson(escaped))
        return escaped;
    const trimmed = escaped.trim();
    if (trimmed && !/^[[{"]/.test(trimmed) && !/^(true|false|null|-?\d+(?:\.\d+)?)$/.test(trimmed)) {
        const quoted = JSON.stringify(trimmed);
        if (isJson(quoted))
            return quoted;
    }
    return '{}';
}
// One-line, secret-free reason for the final "could not recover" message.
function shortErrorReason(errMsg) {
    const text = typeof errMsg === 'string' ? errMsg.replace(/\s+/g, ' ').trim() : '';
    if (!text)
        return 'unknown 400 error';
    const redacted = text
        .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
        .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer [redacted]');
    return redacted.length > 120 ? `${redacted.slice(0, 120)}…` : redacted;
}
// Remove orphaned tool result messages that don't have a matching tool_call_id.
function removeOrphanedToolResults(messages) {
    const validToolCallIds = new Set();
    for (const msg of messages) {
        const msgAny = msg;
        if (msg.role === 'assistant' && Array.isArray(msgAny.tool_calls)) {
            for (const tc of msgAny.tool_calls) {
                if (tc.id)
                    validToolCallIds.add(tc.id);
            }
        }
    }
    const filtered = messages.filter((msg) => {
        const msgAny = msg;
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
function parseRetryAfterMs(headers) {
    if (!headers)
        return 5_000;
    const headerObj = headers;
    // OpenAI SDK errors expose a Headers instance; hand-rolled clients use a plain object.
    const value = typeof headerObj.get === 'function'
        ? headerObj.get('retry-after')
        : headerObj['retry-after'];
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string' && typeof raw !== 'number')
        return 5_000;
    const str = String(raw).trim();
    if (!str)
        return 5_000;
    let seconds;
    if (/^-?\d+(?:\.\d+)?$/.test(str)) {
        seconds = Number(str);
    }
    else {
        const parsed = Date.parse(str);
        if (Number.isNaN(parsed))
            return 5_000;
        seconds = (parsed - Date.now()) / 1000;
    }
    if (!Number.isFinite(seconds) || seconds < 1)
        seconds = 1;
    if (seconds > 60)
        seconds = 60;
    return seconds * 1000;
}
// Keep error messages short and user-facing; never echo raw response bodies.
function safeErrorMessage(errMsg, status) {
    const fallback = status ? `Request failed (status ${status}).` : 'Request failed.';
    if (typeof errMsg !== 'string')
        return fallback;
    const text = errMsg.replace(/\s+/g, ' ').trim();
    const scrubbed = text
        .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer [redacted]');
    const singleLine = scrubbed.startsWith('{') || scrubbed.startsWith('[')
        ? 'Unexpected response from provider.'
        : scrubbed;
    const short = singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
    return status ? `${short} (status ${status})` : short;
}
// Drop tool calls whose function name isn't a registered tool, plus their results.
// Guards against an empty registry (would drop everything) and never strips the
// system prompt or the last user message.
function removeInvalidToolCalls(messages, validToolNames) {
    if (validToolNames.size === 0)
        return { messages, removed: [] };
    const removedIds = new Set();
    const removedNames = new Set();
    const keptMessages = [];
    for (const msg of messages) {
        const msgAny = msg;
        if (msg.role === 'assistant' && Array.isArray(msgAny.tool_calls)) {
            const kept = msgAny.tool_calls.filter((tc) => {
                const name = tc?.function?.name;
                if (!name || !validToolNames.has(name)) {
                    removedNames.add(name || '(unnamed)');
                    if (tc?.id)
                        removedIds.add(tc.id);
                    return false;
                }
                return true;
            });
            if (kept.length === msgAny.tool_calls.length) {
                keptMessages.push(msg);
                continue;
            }
            const hasContent = (typeof msgAny.content === 'string' && msgAny.content.trim().length > 0) ||
                (Array.isArray(msgAny.content) && msgAny.content.length > 0);
            if (hasContent || kept.length > 0) {
                keptMessages.push({ ...msg, tool_calls: kept });
            }
            continue;
        }
        keptMessages.push(msg);
    }
    if (removedIds.size === 0)
        return { messages, removed: [] };
    const result = keptMessages.filter((msg) => {
        const msgAny = msg;
        return !(msg.role === 'tool' && msgAny.tool_call_id && removedIds.has(msgAny.tool_call_id));
    });
    if (!result.some((m) => m.role === 'system') || !result.some((m) => m.role === 'user')) {
        return { messages, removed: [] };
    }
    return { messages: result, removed: [...removedNames] };
}

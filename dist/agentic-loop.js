/**
 * The agentic loop — the core of Bitacode.
 *
 * This module implements the standard tool-use loop:
 *
 *  1. Send the conversation to the LLM with tool definitions
 *  2. If the response contains tool_calls:
 *     a. Execute each tool
 *     b. Append the results to the conversation
 *     c. Go to step 1
 *  3. If the response is plain text:
 *     a. Return it to the caller (the UI renders it)
 *
 * The loop is a plain TypeScript module — not an Ink component.
 * The UI subscribes to events emitted by the loop and updates
 * React state accordingly. This keeps the core logic testable
 * and UI-independent.
 */
import { setMaxListeners } from 'node:events';
import { getAllTools, TOOL_NAME_ALIASES } from './tools/index.js';
import { generateSystemPrompt } from './system-prompt.js';
import { subAgentTool } from './sub-agent.js';
import { getContextInfo, } from './utils/cost-tracker.js';
import { compactIfNeeded, getCompactThreshold } from './utils/compactor.js';
import { logger } from './utils/logger.js';
import { processStream } from './agentic-loop/stream.js';
import { executeToolCalls } from './agentic-loop/executor.js';
import { handleApiError } from './agentic-loop/errors.js';
import { sanitizeMessagesForProvider } from './utils/message-sanitize.js';
import { clearReadState } from './utils/read-state.js';
import { workingCheckpointFrame } from './utils/working-checkpoint.js';
import { memoryFrame } from './utils/memory.js';
import { runHooks } from './utils/hooks.js';
import { appendJournal } from './utils/session-journal.js';
import { isVolatileFrame, volatileFrame } from './utils/context-layers.js';
function emitAbortAndFinish(handler) {
    handler({ type: 'done' });
}
/** True when the history still contains something a provider will accept. */
export function hasConversationPayload(messages) {
    return messages.some((message) => message.role !== 'system');
}
/**
 * Guarantee the request carries a system prompt and at least one conversation
 * message. A repair strategy (or a bug in one) can empty the array; providers
 * then answer 400 "Input required: specify prompt or messages", which used to
 * end the turn with an unrecoverable error.
 */
export function ensureUsableHistory(messages, userInput, systemPrompt, notify) {
    let repaired = false;
    if (messages.length === 0 || messages[0]?.role !== 'system') {
        const hasSystem = messages.some((message) => message.role === 'system');
        if (!hasSystem) {
            messages.unshift({ role: 'system', content: systemPrompt });
            repaired = true;
        }
    }
    if (!hasConversationPayload(messages)) {
        const fallback = typeof userInput === 'string' ? userInput.trim() : '';
        messages.push({ role: 'user', content: fallback || 'continue' });
        repaired = true;
    }
    if (repaired) {
        logger.warn('Restored an empty or unusable conversation history', {
            messagesCount: messages.length,
        });
        notify?.({ type: 'error', error: 'Conversation history was empty. Restored the last request.', transient: true });
    }
    return repaired;
}
/**
 * Names the model may emit: all built-ins, dynamic tools (MCP/skills) and the
 * sub-agent tool, refreshed each iteration. A Set dedupes registrations.
 * Aliases are intentionally absent — they share implementations with a
 * canonical tool, so advertising them would only confuse the model.
 */
export function getValidToolNames() {
    const names = new Set([...getAllTools(), subAgentTool]
        .map((tool) => tool.function?.name)
        .filter((name) => Boolean(name)));
    // Aliases the dispatcher understands (grep, shell, list, …) are valid calls.
    // Leaving them out made the 400-repair step delete working tool calls.
    for (const alias of TOOL_NAME_ALIASES)
        names.add(alias);
    return names;
}
/**
 * Replace the volatile runtime frames at the tail of the conversation.
 *
 * Stable content (system prompt, history) stays at the front so provider prefix
 * caching still hits; only these few hundred tokens change per turn.
 */
function applyRuntimeFrames(messages, sessionId) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === 'system' && isVolatileFrame(message.content)) {
            messages.splice(index, 1);
        }
    }
    const frames = [];
    const checkpoint = workingCheckpointFrame(sessionId);
    if (checkpoint)
        frames.push({ role: 'system', content: volatileFrame('checkpoint', checkpoint) });
    const memory = memoryFrame();
    if (memory)
        frames.push({ role: 'system', content: volatileFrame('memory', memory) });
    if (frames.length > 0)
        messages.push(...frames);
}
/**
 * Process a single user input through the agentic loop.
 *
 * Takes the full conversation history (including system message),
 * runs the loop, and returns the updated message history.
 *
 * The `onEvent` callback is called for each event (text deltas,
 * tool calls, usage info, etc.) so the UI can render progress.
 */
export async function runAgenticLoop(client, model, messages, userInput, onEvent, options = {}) {
    const maxIterations = options.maxIterations ?? 100;
    const pricing = options.pricing;
    const abortSignal = options.abortSignal;
    const sessionId = options.sessionId;
    const requestDefaults = options.requestDefaults || {};
    const timeoutMs = options.timeoutMs ?? 0;
    // Wrap the UI handler once: a throwing listener must never abort the run.
    const emit = (event) => {
        try {
            onEvent(event);
        }
        catch (err) {
            logger.warn('Agent event handler threw', {
                eventType: event.type,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };
    // The same AbortSignal is passed into every OpenAI SDK call and every
    // sleep across all loop iterations and sub-agent calls.
    // The SDK attaches an 'abort' listener per request, so on a long run
    // the default limit of 10 listeners is quickly exceeded, producing the
    // MaxListenersExceededWarning.  AbortSignal is a Web API EventTarget,
    // not a Node EventEmitter, so the instance method .setMaxListeners()
    // doesn't exist on it — use the standalone setMaxListeners() from
    // node:events instead, which handles both EventEmitter and EventTarget.
    if (abortSignal) {
        setMaxListeners(0, abortSignal); // 0 = unlimited, scoped to this signal only
    }
    // Note: userInput is passed for context/logging but user message should already be in messages array
    // (added by the caller in handleSubmit for immediate UI display)
    const updatedMessages = [...messages];
    // UserPromptSubmit hooks run before anything is sent. A blocking hook turns
    // the turn into a no-op with an explanation instead of sending the prompt.
    if (options.hooks && options.hooks.length > 0) {
        const hookOutcome = await runHooks({
            event: 'UserPromptSubmit',
            hooks: options.hooks,
            cwd: process.cwd(),
            payload: { event: 'UserPromptSubmit', sessionId, cwd: process.cwd(), prompt: userInput },
        });
        if (hookOutcome.blocked) {
            emit({ type: 'error', error: `Prompt blocked by a hook${hookOutcome.reason ? `: ${hookOutcome.reason}` : ''}` });
            emit({ type: 'done' });
            return updatedMessages;
        }
    }
    // Refresh system prompt to pick up any new skills or project changes
    const newSystemPrompt = await generateSystemPrompt();
    const systemMsgIndex = updatedMessages.findIndex((m) => m.role === 'system');
    if (systemMsgIndex !== -1) {
        updatedMessages[systemMsgIndex] = { role: 'system', content: newSystemPrompt };
    }
    let iterationCount = 0;
    const retryState = {
        repairCount: 0,
        contextCount: 0,
        truncateCount: 0,
        continueCount: 0,
        retriggerCount: 0,
        transientCount: 0,
    };
    const MAX_RETRIGGERS = 3;
    const MAX_CONSECUTIVE_INVALID_JSON = 3;
    let consecutiveInvalidJson = 0;
    let validToolNames = getValidToolNames();
    const startTime = Date.now();
    while (iterationCount < maxIterations) {
        // Check if abort was requested
        if (abortSignal?.aborted) {
            logger.debug('Agentic loop aborted by user');
            emitAbortAndFinish(emit);
            return updatedMessages;
        }
        // Dynamic tools (MCP/skills) may register after the loop starts.
        validToolNames = getValidToolNames();
        // Wall-clock guard: a model can stall even while bounded by maxIterations.
        if (timeoutMs > 0 && Date.now() - startTime >= timeoutMs) {
            logger.warn('Agentic loop timed out', { timeoutMs, iterationCount });
            emit({ type: 'error', error: 'Agentic loop timed out.', transient: true });
            emit({ type: 'done' });
            return updatedMessages;
        }
        iterationCount++;
        // Check for compaction when we have pricing info (includes context window).
        // Compaction preserves: (1) the system prompt, (2) recent history, and
        // (3) skill content whose parent tool call is still present. Middle
        // messages are summarised into a secondary system message.
        //
        // The threshold from settings is a fraction (0.5–0.95) while
        // `utilizationPercentage` is 0–100, so convert before comparing. Both
        // sides use the same clamp, otherwise the outer gate can fire while the
        // compactor decides there is nothing to do.
        if (pricing) {
            const contextInfo = getContextInfo(updatedMessages, pricing);
            const thresholdPercent = getCompactThreshold(options.compactThreshold) * 100;
            if (contextInfo.needsCompaction || contextInfo.utilizationPercentage >= thresholdPercent) {
                const compacted = await compactIfNeeded(client, model, updatedMessages, pricing.contextWindow, requestDefaults, sessionId, options.compactThreshold);
                // `compactIfNeeded` returns the input array by identity when it decides
                // not to compact. Clearing first would then delete the whole
                // conversation (the provider answered 400 "specify prompt or
                // messages"). Only swap when a different, non-empty history comes back.
                if (compacted !== updatedMessages && compacted.length > 0) {
                    updatedMessages.length = 0;
                    updatedMessages.push(...compacted);
                    // The bytes are gone from context, so "already read" is no longer true.
                    clearReadState(sessionId);
                    if (sessionId)
                        appendJournal(sessionId, { type: 'compaction', data: { messages: compacted.length } });
                }
            }
        }
        // Last line of defence: a repair/compaction step must never leave a payload
        // with no conversation in it. Re-seed with the system prompt and the user
        // turn that started this run.
        ensureUsableHistory(updatedMessages, userInput, newSystemPrompt, emit);
        // Per-turn frames go at the tail: checkpoint notes and saved memory.
        applyRuntimeFrames(updatedMessages, sessionId);
        // Declare assistantMessage outside try block so it's accessible in catch
        let assistantMessage;
        try {
            // Build tools list: core tools + sub-agent tool + dynamic (MCP) tools
            const allTools = [...getAllTools(), subAgentTool];
            logger.info('Making API request', {
                model,
                toolsCount: allTools.length,
                messagesCount: updatedMessages.length,
            });
            // Debug: log message roles and sizes
            logger.trace('Messages', { msgs: updatedMessages.map((m) => ({
                    role: m.role,
                    len: m.content?.length || m.tool_calls?.length || 0,
                })) });
            const stream = await client.chat.completions.create({
                ...requestDefaults,
                model,
                // Strip UI-only fields (reasoning, bitacode* metadata) before sending.
                messages: sanitizeMessagesForProvider(updatedMessages),
                tools: allTools,
                tool_choice: 'auto',
                stream: true,
                stream_options: { include_usage: true },
            }, {
                signal: abortSignal,
            });
            // Process the streaming response
            const streamResult = await processStream(stream, updatedMessages, model, pricing, emit);
            assistantMessage = streamResult.assistantMessage;
            // Handle tool calls
            if (streamResult.hasToolCalls) {
                // Reset retrigger count on valid tool call response
                retryState.retriggerCount = 0;
                // Clean up empty tool_calls entries (from sparse array)
                assistantMessage.tool_calls = assistantMessage.tool_calls.filter(Boolean);
                // Validate that all tool calls have valid JSON arguments
                const invalidToolCalls = assistantMessage.tool_calls.filter((tc) => {
                    const args = tc.function?.arguments;
                    if (!args)
                        return false; // Empty args is valid
                    try {
                        JSON.parse(args);
                        return false; // Valid JSON
                    }
                    catch {
                        return true; // Invalid JSON
                    }
                });
                if (invalidToolCalls.length > 0) {
                    consecutiveInvalidJson++;
                    if (consecutiveInvalidJson >= MAX_CONSECUTIVE_INVALID_JSON) {
                        logger.warn('Model repeatedly produced invalid tool arguments; stopping', {
                            count: consecutiveInvalidJson,
                        });
                        emit({ type: 'error', error: 'Model repeatedly produced invalid tool arguments.' });
                        emit({ type: 'done' });
                        return updatedMessages;
                    }
                    logger.warn('Assistant produced tool calls with invalid JSON, skipping this turn', {
                        invalidToolCalls: invalidToolCalls.map((tc) => ({
                            name: tc.function?.name,
                            argsPreview: tc.function?.arguments?.slice(0, 100),
                        })),
                    });
                    // Don't add the malformed assistant message to conversation
                    // The loop will continue and retry
                    continue;
                }
                // A well-formed response breaks the consecutive-invalid streak.
                consecutiveInvalidJson = 0;
                // Drop duplicate tool_call ids (keep the first). Duplicates would
                // produce duplicate tool results and corrupt provider history.
                const seenToolCallIds = new Set();
                assistantMessage.tool_calls = assistantMessage.tool_calls.filter((tc) => {
                    const id = tc?.id;
                    if (typeof id === 'string' && id.length > 0) {
                        if (seenToolCallIds.has(id)) {
                            logger.warn('Dropping duplicate tool call id', { id, tool: tc.function?.name });
                            return false;
                        }
                        seenToolCallIds.add(id);
                    }
                    return true;
                });
                logger.info('Model returned tool calls', {
                    count: assistantMessage.tool_calls.length,
                    tools: assistantMessage.tool_calls.map((tc) => tc.function?.name).join(', '),
                });
                updatedMessages.push(assistantMessage);
                // Execute tool calls
                const toolContext = {
                    sessionId,
                    abortSignal,
                    requestDefaults,
                    client,
                    model,
                    pricing,
                    ...(options.toolPolicy || options.hooks
                        ? { policy: { hooks: options.hooks, ...(options.toolPolicy ?? {}) } }
                        : {}),
                };
                const executionResult = await executeToolCalls(assistantMessage.tool_calls, updatedMessages, emit, toolContext);
                if (executionResult.shouldAbort) {
                    emitAbortAndFinish(emit);
                    return updatedMessages;
                }
                // Signal UI that this iteration's tool calls are all done,
                // so it can flush completed messages to static output.
                emit({ type: 'iteration_done' });
                // Continue loop — let the LLM process tool results
                continue;
            }
            // Plain text response — we're done
            if (assistantMessage.content) {
                updatedMessages.push({
                    role: 'assistant',
                    content: assistantMessage.content,
                    ...(assistantMessage.reasoning ? { reasoning: assistantMessage.reasoning } : {}),
                });
                // Reset retry counts on valid content response
                retryState.retriggerCount = 0;
                consecutiveInvalidJson = 0;
            }
            // Check if we need to retrigger: if the last message is a tool result
            // but we got no assistant response (empty content, no tool_calls), the AI
            // may have stopped prematurely. Inject a 'continue' prompt and retry.
            const lastMessage = updatedMessages[updatedMessages.length - 1];
            if (lastMessage?.role === 'tool' && retryState.retriggerCount < MAX_RETRIGGERS) {
                retryState.retriggerCount++;
                logger.warn('AI stopped after tool call without responding; retriggering', {
                    retriggerCount: retryState.retriggerCount,
                    maxRetriggers: MAX_RETRIGGERS,
                    lastMessageRole: lastMessage.role,
                    assistantContent: assistantMessage.content || '(empty)',
                    hasToolCalls: assistantMessage.tool_calls?.length > 0,
                });
                // Inject a 'continue' prompt to help the AI continue
                updatedMessages.push({
                    role: 'user',
                    content: 'Please continue.',
                });
                continue;
            }
            // Reset retry counts on successful completion. The transient budget is
            // per failure streak, so a good response clears it for the next turn.
            retryState.repairCount = 0;
            retryState.retriggerCount = 0;
            retryState.transientCount = 0;
            emit({ type: 'done' });
            return updatedMessages;
        }
        catch (apiError) {
            if (abortSignal?.aborted || apiError?.name === 'AbortError' || apiError?.message === 'Operation aborted') {
                logger.debug('Agentic loop request aborted');
                // If we have a partial assistant message with tool_calls, we need to
                // add it to the conversation history before returning, otherwise the
                // message sequence will be invalid (tool results without assistant tool_calls).
                if (assistantMessage && (assistantMessage.content || assistantMessage.tool_calls?.length > 0)) {
                    // Clean up empty tool_calls entries
                    if (assistantMessage.tool_calls?.length > 0) {
                        assistantMessage.tool_calls = assistantMessage.tool_calls.filter(Boolean);
                        // Filter out tool calls with malformed/incomplete JSON arguments
                        assistantMessage.tool_calls = assistantMessage.tool_calls.filter((tc) => {
                            const args = tc.function?.arguments;
                            if (!args)
                                return true; // No args is valid
                            try {
                                JSON.parse(args);
                                return true; // Valid JSON
                            }
                            catch {
                                logger.warn('Filtering out tool call with malformed JSON arguments due to abort', {
                                    tool: tc.function?.name,
                                    argsPreview: args.slice(0, 100),
                                });
                                return false; // Invalid JSON, filter out
                            }
                        });
                    }
                    // Only add the assistant message if we have content or valid tool calls
                    if (assistantMessage.content || assistantMessage.tool_calls?.length > 0) {
                        updatedMessages.push(assistantMessage);
                    }
                }
                emitAbortAndFinish(emit);
                return updatedMessages;
            }
            // Handle API errors with retry strategies
            const errorResult = await handleApiError(apiError, updatedMessages, validToolNames, pricing, retryState, iterationCount, emit, client, model, requestDefaults, sessionId, abortSignal, undefined, userInput);
            if (errorResult.shouldAbort) {
                emitAbortAndFinish(emit);
                return updatedMessages;
            }
            if (!errorResult.handled) {
                // Non-retryable error
                emit({
                    type: 'error',
                    error: errorResult.errorMessage || 'Unknown error',
                    transient: errorResult.transient,
                });
                emit({ type: 'done' });
                return updatedMessages;
            }
            // If handled but not silently, the error was already emitted
            if (!errorResult.silentRetry) {
                emit({ type: 'done' });
                return updatedMessages;
            }
            // Silent retry - continue the loop
            continue;
        }
    }
    emit({ type: 'error', error: 'Maximum iteration limit reached.' });
    emit({ type: 'done' });
    return updatedMessages;
}
/**
 * Initialize the conversation with the system prompt.
 */
export async function initializeMessages() {
    const systemPrompt = await generateSystemPrompt();
    return [{ role: 'system', content: systemPrompt }];
}

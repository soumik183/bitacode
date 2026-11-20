/**
 * Conversation compaction.
 *
 * When the conversation approaches the context window limit (a configurable
 * fraction, 90% by default), the compactor summarises older messages and replaces
 * them with a compact summary. The most recent messages are kept
 * verbatim so the agent doesn't lose immediate context.
 */
import { estimateConversationTokens } from './cost-tracker.js';
import { logger } from './logger.js';
import { sanitizeMessagesForProvider } from './message-sanitize.js';
import { getTodosForSession } from '../tools/todo.js';
import { COMPACT_THRESHOLD_DEFAULT, COMPACT_THRESHOLD_MAX, COMPACT_THRESHOLD_MIN, } from '../settings.js';
const RECENT_MESSAGES_TO_KEEP = 5;
/** Clamp a user-supplied compaction threshold to the supported range. */
export function getCompactThreshold(threshold) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
        return COMPACT_THRESHOLD_DEFAULT;
    }
    return Math.min(COMPACT_THRESHOLD_MAX, Math.max(COMPACT_THRESHOLD_MIN, threshold));
}
function isProtectedSkillMessage(message) {
    return message.role === 'tool' && typeof message.content === 'string' && message.content.includes('<skill_content ');
}
/**
 * A `tool` message is only valid when the assistant message carrying its
 * `tool_calls` comes right before the run of tool results. Trimming history by
 * message count can cut in the middle of such a run, and providers reject the
 * whole request with a 400. Extend the retained tail backwards until it starts
 * on a message that can stand on its own.
 */
export function alignTailStart(messages, desiredStart) {
    let start = Math.max(1, Math.min(desiredStart, messages.length));
    while (start > 1 && messages[start]?.role === 'tool')
        start--;
    return start;
}
/**
 * Drop any `tool` message that no longer has a preceding assistant message with
 * a matching `tool_calls` id. Belt-and-braces for compacted histories.
 */
export function dropOrphanToolMessages(messages) {
    const open = new Set();
    const kept = [];
    for (const message of messages) {
        const anyMessage = message;
        if (message.role === 'assistant' && Array.isArray(anyMessage.tool_calls)) {
            for (const call of anyMessage.tool_calls) {
                if (call && typeof call.id === 'string' && call.id)
                    open.add(call.id);
            }
            kept.push(message);
            continue;
        }
        if (message.role === 'tool') {
            const id = typeof anyMessage.tool_call_id === 'string' ? anyMessage.tool_call_id : '';
            if (!id || !open.has(id))
                continue;
            open.delete(id);
            kept.push(message);
            continue;
        }
        // A non-tool message closes any unanswered call group.
        open.clear();
        kept.push(message);
    }
    return kept;
}
const COMPRESSION_PROMPT = `You are a conversation state manager. Compress the history below into a summary that a competent engineer could resume from with no other context.

Write exactly these sections, in this order, and omit a section only when it would be empty:

## 1. Goal
What the user is trying to accomplish, and what "done" looks like.

## 2. Constraints
Rules, conventions, user preferences and hard limits that must keep being respected (style, libraries, files not to touch, approval requirements).

## 3. Environment
Branch, working directory, language/framework versions, commands that work, and anything learned about the machine.

## 4. Files and state
Every file created, read, modified or deleted, with its path and what changed. Note what is currently broken, mid-edit or untested.

## 5. Decisions
Approaches chosen, approaches rejected, and the reason for each. This prevents re-litigating settled questions.

## 6. Errors and fixes
Failures hit so far, the actual error text, and the fix that worked (or did not).

## 7. Open questions
Anything ambiguous that the user has not answered yet.

## 8. Current plan
Step-by-step plan with status per step: [DONE], [IN PROGRESS], [TODO].

## 9. Next action
The single next thing to do, stated concretely.

Be specific: file paths, function names and exact command lines beat prose. Never invent facts that are not in the history.`;
/**
 * Compact a conversation if it exceeds the context window threshold.
 * Returns the original messages if compaction isn't needed or fails.
 */
export async function compactIfNeeded(client, model, messages, contextWindow, requestDefaults = {}, sessionId, threshold) {
    const currentTokens = estimateConversationTokens(messages);
    const ratio = currentTokens / contextWindow;
    if (ratio < getCompactThreshold(threshold))
        return messages;
    const utilisation = ratio * 100;
    logger.info(`Compacting conversation (${utilisation.toFixed(1)}% of context window used)`);
    try {
        return await compactConversation(client, model, messages, requestDefaults, sessionId);
    }
    catch (err) {
        logger.error(`Compaction failed, continuing with original messages: ${err}`);
        return messages;
    }
}
async function compactConversation(client, model, messages, requestDefaults, sessionId) {
    // Separate system message, history to compress, and recent messages. The tail
    // boundary is realigned so a run of tool results keeps its assistant parent.
    const systemMessage = messages[0];
    const tailStart = alignTailStart(messages, messages.length - RECENT_MESSAGES_TO_KEEP);
    const recentMessages = messages.slice(tailStart);
    const middleMessages = messages.slice(1, tailStart);
    // Skill content is summarised like everything else: keeping the tool message
    // without its parent assistant message is exactly what providers reject.
    const protectedCount = middleMessages.filter(isProtectedSkillMessage).length;
    if (middleMessages.length === 0) {
        logger.debug('Nothing to compact — conversation too short');
        return messages;
    }
    // Build compression request
    const activeTodos = getTodosForSession(sessionId);
    const todoReminder = activeTodos.length > 0
        ? `\n\nActive TODOs:\n${activeTodos.map((todo) => `- [${todo.status}] ${todo.content}`).join('\n')}\n\nThe agent must not stop until the TODO list is fully complete. Preserve that instruction in the summary if work remains.`
        : '';
    const compressionMessages = [
        { role: 'system', content: COMPRESSION_PROMPT },
        {
            role: 'user',
            content: `Here is the conversation history to compress:\n\n${middleMessages
                .map((m) => `[${m.role}]: ${m.content || JSON.stringify(m.tool_calls || '')}`)
                .join('\n\n')}${protectedCount > 0
                ? '\n\nSkill instructions were loaded during this history. Keep every rule, file path and constraint they established.'
                : ''}${todoReminder}`,
        },
    ];
    // Size the summary budget from the history being replaced instead of a fixed
    // 2000-token cap that truncates long conversations mid-sentence.
    const summaryBudget = Math.min(8000, Math.max(1024, Math.round(estimateConversationTokens(middleMessages) * 0.2)));
    const response = await client.chat.completions.create({
        ...requestDefaults,
        model,
        messages: sanitizeMessagesForProvider(compressionMessages),
        max_tokens: summaryBudget,
        temperature: 0.1,
    });
    const summary = response.choices[0]?.message?.content;
    if (!summary) {
        throw new Error('Compression returned empty response');
    }
    // Reconstruct: system + summary + a valid, tool-call-consistent tail.
    const compacted = dropOrphanToolMessages([
        systemMessage,
        { role: 'system', content: `Previous conversation summary:\n\n${summary}` },
        ...recentMessages,
    ]);
    // Never hand back something the provider cannot accept (or something empty).
    if (compacted.length < 2 || !compacted.some((message) => message.role !== 'system')) {
        logger.warn('Compaction produced an unusable history; keeping the original');
        return messages;
    }
    const oldTokens = estimateConversationTokens(messages);
    const newTokens = estimateConversationTokens(compacted);
    logger.info(`Compacted ${oldTokens} → ${newTokens} tokens (${((1 - newTokens / oldTokens) * 100).toFixed(0)}% reduction)`);
    return compacted;
}

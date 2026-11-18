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
const COMPRESSION_PROMPT = `You are a conversation state manager. Your job is to compress a conversation history into a compact summary that preserves all important context.

Produce a structured summary in this format:

<state_snapshot>
<overall_goal>What the user is trying to accomplish</overall_goal>
<key_knowledge>Important facts, conventions, constraints discovered</key_knowledge>
<file_system_state>Files created, read, modified, or deleted (with paths)</file_system_state>
<recent_actions>Last significant actions and their outcomes</recent_actions>
<current_plan>Current step-by-step plan with status: [DONE], [IN PROGRESS], [TODO]</current_plan>
</state_snapshot>

Be thorough but concise. Do not lose any information that would be needed to continue the conversation.`;
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
    // Separate system message, history to compress, and recent messages
    const systemMessage = messages[0];
    const recentMessages = messages.slice(-RECENT_MESSAGES_TO_KEEP);
    const middleMessages = messages.slice(1, messages.length - RECENT_MESSAGES_TO_KEEP);
    const protectedMessages = middleMessages.filter(isProtectedSkillMessage);
    const historyToCompress = middleMessages.filter((message) => !isProtectedSkillMessage(message));
    if (historyToCompress.length === 0) {
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
            content: `Here is the conversation history to compress:\n\n${historyToCompress
                .map((m) => `[${m.role}]: ${m.content || JSON.stringify(m.tool_calls || '')}`)
                .join('\n\n')}${todoReminder}`,
        },
    ];
    const response = await client.chat.completions.create({
        ...requestDefaults,
        model,
        messages: sanitizeMessagesForProvider(compressionMessages),
        max_tokens: 2000,
        temperature: 0.1,
    });
    const summary = response.choices[0]?.message?.content;
    if (!summary) {
        throw new Error('Compression returned empty response');
    }
    // Reconstruct: system + summary + recent messages
    const compacted = [
        systemMessage,
        { role: 'system', content: `Previous conversation summary:\n\n${summary}` },
        ...protectedMessages,
        ...recentMessages,
    ];
    const oldTokens = estimateConversationTokens(messages);
    const newTokens = estimateConversationTokens(compacted);
    logger.info(`Compacted ${oldTokens} → ${newTokens} tokens (${((1 - newTokens / oldTokens) * 100).toFixed(0)}% reduction)`);
    return compacted;
}

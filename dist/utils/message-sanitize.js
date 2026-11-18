/**
 * Provider-message sanitizer.
 *
 * UI-only fields (reasoning replay, sub-agent activity, `bitacode*` metadata)
 * ride along on messages so the TUI can render them. Providers reject unknown
 * fields on message objects with a 400. Strip them at every boundary where
 * history is sent to a provider, and drop entries that are structurally
 * invalid so one bad message cannot fail the whole request.
 */
import { logger } from './logger.js';
const UI_ONLY_FIELDS = new Set(['reasoning', 'subAgentActivities']);
const BITACODE_FIELD = /^bitacode/i;
const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
/** True for a UI-only message key that must never reach a provider. */
export function isUiOnlyMessageField(key) {
    return UI_ONLY_FIELDS.has(key) || BITACODE_FIELD.test(key);
}
function hasContent(message) {
    const content = message?.content;
    return (typeof content === 'string' && content.trim().length > 0)
        || (Array.isArray(content) && content.length > 0);
}
function toolContentToString(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part.text === 'string' ? part.text : String(part ?? '')))
            .join('');
    }
    return String(content ?? '');
}
function sanitizeOne(message, removed) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
        return null;
    const msg = message;
    if (typeof msg.role !== 'string' || !VALID_ROLES.has(msg.role))
        return null;
    let changed = false;
    const clean = {};
    for (const [key, value] of Object.entries(msg)) {
        if (isUiOnlyMessageField(key)) {
            removed.add(key);
            changed = true;
            continue;
        }
        clean[key] = value;
    }
    if (msg.role === 'tool') {
        if (typeof msg.tool_call_id !== 'string' || msg.tool_call_id.length === 0)
            return null;
        if (typeof clean.content !== 'string') {
            clean.content = toolContentToString(clean.content);
            changed = true;
        }
    }
    // An assistant message with neither text nor tool calls is not valid history.
    if (msg.role === 'assistant' && !hasContent(msg) && !(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)) {
        removed.add('(empty assistant message)');
        return null;
    }
    return changed ? clean : message;
}
/**
 * Return a provider-safe copy of `messages`, or the original array by identity
 * when nothing needed changing (so callers can cheaply detect a real repair).
 */
export function sanitizeMessagesForProvider(messages) {
    if (!Array.isArray(messages))
        return [];
    const removed = new Set();
    const result = [];
    let dropped = 0;
    for (const message of messages) {
        const clean = sanitizeOne(message, removed);
        if (clean === null) {
            dropped++;
            continue;
        }
        result.push(clean);
    }
    const changed = dropped > 0 || result.some((message, index) => message !== messages[index]);
    if (changed) {
        // Field names only — never message content.
        logger.warn('Sanitized messages for provider', {
            removedFields: [...removed],
            droppedMessages: dropped,
        });
    }
    return changed ? result : messages;
}

/**
 * Provider-message sanitizer.
 *
 * UI-only fields (reasoning replay, sub-agent activity, `bitacode*` metadata)
 * ride along on messages so the TUI can render them. Providers reject unknown
 * fields on message objects with a 400. Strip them at every boundary where
 * history is sent to a provider, and drop entries that are structurally
 * invalid so one bad message cannot fail the whole request.
 */

import type { Message } from '../agentic-loop.js';
import { logger } from './logger.js';

const UI_ONLY_FIELDS = new Set(['reasoning', 'subAgentActivities']);
const BITACODE_FIELD = /^bitacode/i;
const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/** True for a UI-only message key that must never reach a provider. */
export function isUiOnlyMessageField(key: string): boolean {
  return UI_ONLY_FIELDS.has(key) || BITACODE_FIELD.test(key);
}

function hasContent(message: any): boolean {
  const content = message?.content;
  return (typeof content === 'string' && content.trim().length > 0)
    || (Array.isArray(content) && content.length > 0);
}

function toolContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part && typeof part.text === 'string' ? part.text : String(part ?? '')))
      .join('');
  }
  return String(content ?? '');
}

function sanitizeOne(message: Message, removed: Set<string>): Message | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const msg = message as any;
  if (typeof msg.role !== 'string' || !VALID_ROLES.has(msg.role)) return null;

  let changed = false;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) {
    if (isUiOnlyMessageField(key)) {
      removed.add(key);
      changed = true;
      continue;
    }
    clean[key] = value;
  }

  if (msg.role === 'tool') {
    if (typeof msg.tool_call_id !== 'string' || msg.tool_call_id.length === 0) return null;
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

  return changed ? (clean as unknown as Message) : message;
}

/**
 * Return a provider-safe copy of `messages`, or the original array by identity
 * when nothing needed changing (so callers can cheaply detect a real repair).
 */
export function sanitizeMessagesForProvider(messages: Message[]): Message[] {
  if (!Array.isArray(messages)) return [];

  const removed = new Set<string>();
  const result: Message[] = [];
  let dropped = 0;
  // Track repairs explicitly: comparing by index breaks as soon as one message
  // is dropped, which used to report a change (and log a warning) for arrays
  // that only had an element removed from the middle.
  let repaired = 0;

  for (const message of messages) {
    const clean = sanitizeOne(message, removed);
    if (clean === null) {
      dropped++;
      continue;
    }
    if (clean !== message) repaired++;
    result.push(clean);
  }

  const changed = dropped > 0 || repaired > 0;
  if (changed) {
    // Field names only — never message content.
    logger.warn('Sanitized messages for provider', {
      removedFields: [...removed],
      droppedMessages: dropped,
    });
  }
  return changed ? result : messages;
}

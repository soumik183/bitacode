import {
  errorMessage,
  MAX_MESSAGE_CHARS,
  MAX_QUEUED_PER_AGENT,
  MAX_REGISTRY_ENTRIES,
  queuedMessages,
  type AgentMessageArgs,
} from './task-registry.js';

/** Snapshot of messages queued for a sub-agent id. */
export function getQueuedMessages(id: string): string[] {
  return [...(queuedMessages.get(id) ?? [])];
}

export function clearQueuedMessages(id?: string): void {
  if (id) queuedMessages.delete(id);
  else queuedMessages.clear();
}

export const agentMessageTool = {
  type: 'function' as const,
  function: {
    name: 'agent_message',
    description: 'Queue a message for a sub-agent by id. The child sees it only when it reads its queue; no process is interrupted.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Target sub-agent id.' },
        message: { type: 'string', description: 'Message to queue.' },
      },
      required: ['id', 'message'],
    },
  },
};

export async function agentMessage(args: AgentMessageArgs = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const id = typeof a.id === 'string' ? a.id.trim().slice(0, 120) : '';
    if (!id) return 'Error: id must be a non-empty string.';
    const message = typeof a.message === 'string' ? a.message.trim().slice(0, MAX_MESSAGE_CHARS) : '';
    if (!message) return 'Error: message must be a non-empty string.';

    const queue = queuedMessages.get(id) ?? [];
    if (queue.length >= MAX_QUEUED_PER_AGENT) {
      return `Error: message queue for sub-agent "${id}" is full (${MAX_QUEUED_PER_AGENT}).`;
    }
    queue.push(message);
    queuedMessages.set(id, queue);
    if (queuedMessages.size > MAX_REGISTRY_ENTRIES) {
      const oldest = queuedMessages.keys().next().value;
      if (oldest !== undefined) queuedMessages.delete(oldest);
    }
    return `Message queued for sub-agent "${id}" (position ${queue.length}). It is not delivered until the child reads it; no running process was interrupted.`;
  } catch (err) {
    return errorMessage('agent_message', err);
  }
}

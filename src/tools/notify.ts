import { errorMessage, MAX_NOTIFY_CHARS, type NotifyArgs } from './task-registry.js';

export const notifyTool = {
  type: 'function' as const,
  function: {
    name: 'notify',
    description: 'Show a user-facing notification (rendered as a toast by the UI).',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Notification text.' },
        title: { type: 'string', description: 'Optional title.' },
      },
      required: ['message'],
    },
  },
};

export async function notify(args: NotifyArgs = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const message = typeof a.message === 'string' ? a.message.trim() : '';
    if (!message) return 'Error: message must be a non-empty string.';
    const title = typeof a.title === 'string' ? a.title.trim() : '';
    const text = (title ? `${title}: ${message}` : message).slice(0, MAX_NOTIFY_CHARS);
    return `NOTIFY: ${text}`;
  } catch (err) {
    return errorMessage('notify', err);
  }
}

/** True when a tool-result string should be rendered as a toast. */
export function isNotification(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('NOTIFY:');
}

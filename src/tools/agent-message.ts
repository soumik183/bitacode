import {
  cap,
  errorMessage,
  MAX_MESSAGE_CHARS,
  MAX_QUEUED_PER_AGENT,
  MAX_REGISTRY_ENTRIES,
  queuedMessages,
  type AgentMessageArgs,
} from './task-registry.js';
import {
  DEFAULT_TEAM,
  TEAM_CHANNEL,
  postMessage,
  readMessages,
} from '../utils/team.js';

/** Legacy args plus the team-messaging fields. All fields stay `unknown` at the edge. */
export interface ExtendedAgentMessageArgs extends AgentMessageArgs {
  action?: unknown;
  to?: unknown;
  from?: unknown;
  team?: unknown;
  after?: unknown;
  body?: unknown;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function clean(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseAfter(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Snapshot of messages queued for a sub-agent id. */
export function getQueuedMessages(id: string): string[] {
  return [...(queuedMessages.get(id) ?? [])];
}

export function clearQueuedMessages(id?: string): void {
  if (id) queuedMessages.delete(id);
  else queuedMessages.clear();
}

/** Post to a teammate by name, or to `*` (the whole team channel). */
export async function postTeamMessage(args: unknown = {}): Promise<string> {
  try {
    const a = asRecord(args);
    const team = clean(a.team, 80) || DEFAULT_TEAM;
    const from = clean(a.from, 80) || 'parent';
    const to = clean(a.to, 80) || TEAM_CHANNEL;
    const body = clean(a.message ?? a.body, MAX_MESSAGE_CHARS);
    if (!body) return 'Error: message must be a non-empty string.';
    const posted = postMessage(team, from, to, body);
    if (!posted) return 'Error: team, from, to and body must be non-empty strings.';
    const target = posted.to === TEAM_CHANNEL ? 'the team channel' : `teammate "${posted.to}"`;
    return `Message #${posted.seq} posted to ${target} in team "${team}" by ${from}.`;
  } catch (err) {
    return errorMessage('agent_message', err);
  }
}

/** Read team messages with `seq > after`; `to` also picks up channel broadcasts. */
export async function readTeamMessages(args: unknown = {}): Promise<string> {
  try {
    const a = asRecord(args);
    const team = clean(a.team, 80) || DEFAULT_TEAM;
    const after = parseAfter(a.after);
    const to = clean(a.to, 80) || undefined;
    const messages = readMessages(team, after, to);
    if (messages.length === 0) {
      return `No messages in team "${team}" after seq ${after}${to ? ` for "${to}"` : ''}.`;
    }
    const lines = messages.map((m) => `#${m.seq} ${m.from} → ${m.to}: ${m.body}`);
    return cap(`Messages in team "${team}" after seq ${after} (${messages.length}):\n${lines.join('\n')}`);
  } catch (err) {
    return errorMessage('agent_message', err);
  }
}

export const agentMessageTool = {
  type: 'function' as const,
  function: {
    name: 'agent_message',
    description:
      'Message a teammate or read a team channel. Post with `to` (a teammate name, or "*" for the team channel) and `message`; read with action:"read", optional `after` sequence, `team` and `to` filter. Legacy `id` + `message` still queues a message for a sub-agent by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Legacy: target sub-agent id (queues until it reads its queue).' },
        message: { type: 'string', description: 'Message body to post or queue.' },
        to: { type: 'string', description: 'Teammate name, or "*" for the whole team channel (omit for legacy id queueing).' },
        from: { type: 'string', description: 'Sender name for team posts. Defaults to "parent".' },
        team: { type: 'string', description: 'Team/channel name. Defaults to "default".' },
        action: { type: 'string', enum: ['post', 'read'], description: 'Use "read" to fetch messages; defaults to post/queue.' },
        after: { type: 'number', description: 'For reads: only messages with seq greater than this. Defaults to 0.' },
      },
      required: [],
    },
  },
};

export async function agentMessage(args: ExtendedAgentMessageArgs = {}): Promise<string> {
  const a = asRecord(args);
  if (clean(a.action, 20).toLowerCase() === 'read') return readTeamMessages(a);
  if (clean(a.to) || clean(a.team, 80)) return postTeamMessage(a);

  // Legacy behavior: queue a message for a sub-agent id. Kept verbatim.
  try {
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

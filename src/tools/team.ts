/**
 * Team tools — agent-to-agent messaging and in-memory agent definitions.
 *
 * Nothing here touches the filesystem or starts a model run: `team_spawn`
 * records an intent and returns instructions for the parent to execute.
 */

import { cap, errorMessage } from './task-registry.js';
import { postTeamMessage, readTeamMessages } from './agent-message.js';
import {
  DEFAULT_TEAM,
  defineAgent,
  getAgent,
  listAgents,
  recordSpawnIntent,
  teamRoster,
} from '../utils/team.js';

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function clean(value: unknown, max = 80): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const teamPostTool = {
  type: 'function' as const,
  function: {
    name: 'team_post',
    description: 'Post a message to a teammate by name or to the whole team channel with to:"*". Stored in memory; read with team_read.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message body.' },
        to: { type: 'string', description: 'Teammate name, or "*" for the team channel. Defaults to "*".' },
        team: { type: 'string', description: 'Team/channel name. Defaults to "default".' },
        from: { type: 'string', description: 'Sender name. Defaults to "parent".' },
      },
      required: ['body'],
    },
  },
};

export const teamReadTool = {
  type: 'function' as const,
  function: {
    name: 'team_read',
    description: 'Read team messages with seq greater than `after`; `to` keeps only that teammate and channel broadcasts.',
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team/channel name. Defaults to "default".' },
        after: { type: 'number', description: 'Only messages with seq greater than this. Defaults to 0.' },
        to: { type: 'string', description: 'Optional recipient filter; channel broadcasts ("*") are always included.' },
      },
      required: [],
    },
  },
};

export const teamListTool = {
  type: 'function' as const,
  function: {
    name: 'team_list',
    description: 'List team channels, their message counts and members, plus registered custom agent definitions.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

export const teamSpawnTool = {
  type: 'function' as const,
  function: {
    name: 'team_spawn',
    description: 'Record a request to spawn a named teammate for a task. Does NOT start a child or call the model; returns instructions for the parent.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the new teammate.' },
        task: { type: 'string', description: 'Task the teammate should perform.' },
        team: { type: 'string', description: 'Team/channel the teammate joins. Defaults to "default".' },
      },
      required: ['name', 'task'],
    },
  },
};

export const agentDefineTool = {
  type: 'function' as const,
  function: {
    name: 'agent_define',
    description: 'Register a custom agent definition in memory (name, description, system prompt, allowed tools). No files are written.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name.' },
        description: { type: 'string', description: 'Short description of the agent.' },
        system_prompt: { type: 'string', description: 'System prompt for this agent.' },
        allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Tool names this agent may use.' },
      },
      required: ['name', 'description', 'system_prompt'],
    },
  },
};

export async function teamPost(args: unknown = {}): Promise<string> {
  try {
    return await postTeamMessage(args);
  } catch (err) {
    return errorMessage('team_post', err);
  }
}

export async function teamRead(args: unknown = {}): Promise<string> {
  try {
    return await readTeamMessages(args);
  } catch (err) {
    return errorMessage('team_read', err);
  }
}

export async function teamList(_args: unknown = {}): Promise<string> {
  try {
    const roster = teamRoster();
    if (roster.length === 0) return 'No teams registered.';
    const lines = roster.map((entry) =>
      `- ${entry.team}: ${entry.messageCount} message(s), last seq ${entry.lastSeq}, members: ${entry.members.join(', ') || 'none'}`);
    const agents = listAgents();
    const defined = agents.length ? `\nAgent definitions: ${agents.map((a) => a.name).join(', ')}` : '';
    return cap(`Teams (${roster.length}):\n${lines.join('\n')}${defined}`);
  } catch (err) {
    return errorMessage('team_list', err);
  }
}

export async function teamSpawn(args: unknown = {}): Promise<string> {
  try {
    const a = asRecord(args);
    const name = clean(a.name);
    const task = clean(a.task, 4_000);
    const team = clean(a.team) || DEFAULT_TEAM;
    if (!name) return 'Error: name must be a non-empty string.';
    if (!task) return 'Error: task must be a non-empty string.';
    const intent = recordSpawnIntent(name, task, team);
    const definition = getAgent(name);
    const guide = definition
      ? `Use its registered system prompt and allowed tools: ${definition.allowedTools.join(', ') || 'none'}.`
      : 'No definition is registered for this name, so treat it as general-purpose.';
    return cap(
      `Spawn intent ${intent.id} recorded for "${name}" on team "${team}". No child was started.\n` +
      `To execute, the parent should call sub_agent with task:\n${intent.task}\n${guide}`,
    );
  } catch (err) {
    return errorMessage('team_spawn', err);
  }
}

export async function agentDefine(args: unknown = {}): Promise<string> {
  try {
    const a = asRecord(args);
    const name = clean(a.name);
    const description = clean(a.description, 300);
    const systemPrompt = clean(a.system_prompt ?? a.systemPrompt ?? a.prompt, 4_000);
    const rawTools = a.allowed_tools ?? a.allowedTools;
    const allowedTools = Array.isArray(rawTools) ? rawTools : [];
    if (!name) return 'Error: name must be a non-empty string.';
    if (!description) return 'Error: description must be a non-empty string.';
    if (!systemPrompt) return 'Error: system_prompt must be a non-empty string.';
    const definition = defineAgent(name, description, systemPrompt, allowedTools);
    if (!definition) return 'Error: could not register agent definition.';
    return `Agent definition "${definition.name}" registered: ${definition.description}\nAllowed tools: ${definition.allowedTools.join(', ') || 'none'}\nStored in memory only.`;
  } catch (err) {
    return errorMessage('agent_define', err);
  }
}

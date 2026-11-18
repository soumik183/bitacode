import {
  cap,
  errorMessage,
  MAX_REGISTRY_ENTRIES,
  MAX_STATUS_ROWS,
  statusRegistry,
  type AgentStatusArgs,
  type SubAgentStatusEntry,
} from './task-registry.js';
import { getQueuedMessages } from './agent-message.js';

/** Called by sub-agent events to record/update an activity entry. Capped at 100. */
export function recordSubAgentStatus(id: string, task: string, status: string, toolCount = 0): void {
  const cleanId = typeof id === 'string' ? id.trim().slice(0, 120) : '';
  if (!cleanId) return;
  const entry: SubAgentStatusEntry = {
    id: cleanId,
    task: (typeof task === 'string' ? task.trim() : '').slice(0, 300),
    status: (typeof status === 'string' ? status.trim() : '').slice(0, 60) || 'unknown',
    toolCount: Number.isFinite(toolCount) && toolCount >= 0 ? Math.floor(toolCount) : 0,
    updatedAt: Date.now(),
  };
  statusRegistry.delete(cleanId);
  statusRegistry.set(cleanId, entry);
  if (statusRegistry.size > MAX_REGISTRY_ENTRIES) {
    const oldest = statusRegistry.keys().next().value;
    if (oldest !== undefined) statusRegistry.delete(oldest);
  }
}

/** Snapshot of recent activities, newest first. */
export function getSubAgentStatuses(): SubAgentStatusEntry[] {
  return [...statusRegistry.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_REGISTRY_ENTRIES);
}

export const agentStatusTool = {
  type: 'function' as const,
  function: {
    name: 'agent_status',
    description: 'List recent sub-agent activity (id, task, status, tool count, queued messages). Pass id to filter.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional sub-agent id to filter results.' },
      },
      required: [],
    },
  },
};

export async function agentStatus(args: AgentStatusArgs = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : undefined;
    const all = getSubAgentStatuses();
    const list = id ? all.filter((entry) => entry.id === id) : all;
    if (list.length === 0) {
      return id ? `No sub-agent activity recorded for "${id}".` : 'No sub-agent activity recorded.';
    }

    const shown = list.slice(0, MAX_STATUS_ROWS);
    const header = 'ID'.padEnd(20) + 'TASK'.padEnd(32) + 'STATUS'.padEnd(14) + 'TOOLS'.padEnd(7) + 'MSG';
    const rows = shown.map((entry) => {
      const cell = (value: string, width: number): string =>
        (value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value).padEnd(width);
      return cell(entry.id, 20) + cell(entry.task, 32) + cell(entry.status, 14)
        + cell(String(entry.toolCount), 7) + String(getQueuedMessages(entry.id).length);
    });
    const more = list.length - shown.length;
    return cap(
      `Sub-agent activity (${list.length}):\n${header}\n${rows.join('\n')}${more ? `\n… ${more} more` : ''}`,
    );
  } catch (err) {
    return errorMessage('agent_status', err);
  }
}

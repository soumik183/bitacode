/**
 * SubAgentActivity — compact live panel showing child-agent progress.
 * Capped at a header + 3 rows so it can never push the composer off-screen.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { LeftBar } from './LeftBar.js';

/** Persisted shape (mirrors SubAgentActivity in sessions.ts). */
export interface SubAgentActivityItem {
  id: string;
  task: string;
  status: 'start' | 'done' | 'error';
  toolCalls?: number;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

/** Optional fields the sub-agent engine adds to `sub_agent_iteration`. */
export interface SubAgentEventFields {
  subAgentId?: string;
  subAgentLabel?: string;
  subAgentStatus?: 'start' | 'done' | 'error';
  subAgentTask?: string;
  subAgentTool?: {
    tool: string;
    status: 'running' | 'done' | 'error';
    iteration: number;
    args?: Record<string, unknown>;
  };
}

export const SUB_AGENT_MAX_VISIBLE = 3;

const STATUS_ICON: Record<SubAgentActivityItem['status'], string> = {
  start: '⠹',
  done: '✓',
  error: '✗',
};

const STATUS_COLOR: Record<SubAgentActivityItem['status'], string> = {
  start: theme.info,
  done: theme.success,
  error: theme.error,
};

/** Upsert one child's state from a synthetic sub_agent_iteration event. */
export function upsertSubAgentActivity(
  list: SubAgentActivityItem[],
  event: SubAgentEventFields,
  now = Date.now()
): SubAgentActivityItem[] {
  const id = event.subAgentId;
  if (!id) return list;

  const tool = event.subAgentTool;
  const finished = event.subAgentStatus === 'done' || event.subAgentStatus === 'error';
  const index = list.findIndex((item) => item.id === id);
  const existing = list[index];

  const next: SubAgentActivityItem = existing
    ? {
        ...existing,
        status: event.subAgentStatus ?? existing.status,
        task: event.subAgentTask?.trim() ? event.subAgentTask : existing.task,
        toolCalls: tool?.status === 'running' ? (existing.toolCalls ?? 0) + 1 : existing.toolCalls,
        summary: finished && tool ? tool.tool : existing.summary,
        endedAt: finished ? now : existing.endedAt,
      }
    : {
        id,
        task: event.subAgentTask || event.subAgentLabel || 'sub-agent task',
        status: event.subAgentStatus ?? 'start',
        toolCalls: tool?.status === 'running' ? 1 : 0,
        summary: finished && tool ? tool.tool : undefined,
        startedAt: now,
        endedAt: finished ? now : undefined,
      };

  if (!existing) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/** One-line summary for the replay card flushed into scrollback. */
export function subAgentActivitySummary(list: SubAgentActivityItem[]): string {
  const done = list.filter((item) => item.status === 'done').length;
  const error = list.filter((item) => item.status === 'error').length;
  const running = list.length - done - error;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (error) parts.push(`${error} error${error === 1 ? '' : 's'}`);
  if (running) parts.push(`${running} running`);
  const count = list.length;
  return `${count} sub-agent${count === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** Rows the panel occupies, matching the render below (header + items). */
export function subAgentActivityRows(list: SubAgentActivityItem[]): number {
  if (list.length === 0) return 0;
  return 1 + Math.min(list.length, SUB_AGENT_MAX_VISIBLE);
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  if (max <= 1) return '…';
  return `${one.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function elapsed(item: SubAgentActivityItem, now: number): string {
  const ms = Math.max(0, (item.endedAt ?? now) - item.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export interface SubAgentActivityProps {
  activities: SubAgentActivityItem[];
  columns: number;
  /** Injectable clock so tests can assert elapsed time deterministically. */
  now?: number;
}

export const SubAgentActivity: React.FC<SubAgentActivityProps> = ({ activities, columns, now }) => {
  if (activities.length === 0) return null;
  const visible = activities.slice(-SUB_AGENT_MAX_VISIBLE);
  const nowMs = now ?? Date.now();
  const labelWidth = 10;
  const tailWidth = 18; // "  N tools · 1.2s"
  const taskWidth = Math.max(1, columns - 6 - labelWidth - tailWidth);

  return (
    <Box paddingX={2}>
      <LeftBar color={theme.info}>
        <Box flexDirection="column">
          <Text color={theme.muted} bold>Sub-agents</Text>
          {visible.map((item) => (
            <Box key={item.id} flexDirection="row">
              <Text color={STATUS_COLOR[item.status]}>{`${STATUS_ICON[item.status]} `}</Text>
              <Text color={theme.dim} wrap="truncate-end">{`${shortId(item.id)} `}</Text>
              <Text color={theme.text} wrap="truncate-end">{truncate(item.task, taskWidth)}</Text>
              <Text color={theme.dim} wrap="truncate-end">{`  ${item.toolCalls ?? 0} tools · ${elapsed(item, nowMs)}`}</Text>
            </Box>
          ))}
        </Box>
      </LeftBar>
    </Box>
  );
};

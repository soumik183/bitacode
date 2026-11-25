/**
 * SubAgentActivity — compact live panel showing child-agent progress.
 * Capped at a header + 3 rows so it can never push the composer off-screen.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../theme.js';
import { displayWidth } from '../utils/format-message.js';
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
  agentType?: string;
}

/** Optional fields the sub-agent engine adds to `sub_agent_iteration`. */
export interface SubAgentEventFields {
  subAgentId?: string;
  subAgentLabel?: string;
  subAgentStatus?: 'start' | 'done' | 'error';
  subAgentTask?: string;
  subAgentType?: string;
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

/** Status → semantic palette key, resolved from the active palette at render. */
const STATUS_COLOR_KEY: Record<SubAgentActivityItem['status'], keyof Theme> = {
  start: 'info',
  done: 'success',
  error: 'error',
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
        agentType: event.subAgentType?.trim() ? event.subAgentType : existing.agentType,
      }
    : {
        id,
        task: event.subAgentTask || event.subAgentLabel || 'sub-agent task',
        status: event.subAgentStatus ?? 'start',
        toolCalls: tool?.status === 'running' ? 1 : 0,
        summary: finished && tool ? tool.tool : undefined,
        startedAt: now,
        endedAt: finished ? now : undefined,
        agentType: event.subAgentType?.trim() ? event.subAgentType : undefined,
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

/** Cut the status tail to an exact display-column budget. */
function fitTail(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const limit = Math.max(1, Math.floor(max) - 1);
  let used = 0;
  let out = '';
  for (const ch of text) {
    const width = displayWidth(ch);
    if (used + width > limit) break;
    used += width;
    out += ch;
  }
  return `${out}…`;
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
  const theme = useTheme();
  if (activities.length === 0) return null;
  const visible = activities.slice(-SUB_AGENT_MAX_VISIBLE);
  const nowMs = now ?? Date.now();
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  // Exact fixed costs per item row: outer padding (4), LeftBar bar + gap (2),
  // status icon + space, id + space, optional badge, and the status tail.
  const fixedOverhead = 6;
  const minTaskWidth = 8;

  return (
    <Box paddingX={2}>
      <LeftBar color={theme.info}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
            <Box flexDirection="row" flexShrink={1} minWidth={1}>
              <Text color={theme.muted} bold>Sub-agents</Text>
              <Text color={theme.accent} backgroundColor={theme.surface}>{` ${activities.length} `}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text color={theme.dim} wrap="truncate-end">^g all</Text>
            </Box>
          </Box>
          {visible.map((item) => {
            const badge = item.agentType ? `[${item.agentType}] ` : '';
            const icon = `${STATUS_ICON[item.status]} `;
            const id = `${shortId(item.id)} `;
            const usedWithoutTail = fixedOverhead + displayWidth(icon) + displayWidth(id) + displayWidth(badge);
            const tail = fitTail(
              `  ${item.toolCalls ?? 0} tools · ${elapsed(item, nowMs)}`,
              Math.max(0, cols - usedWithoutTail - minTaskWidth)
            );
            // Derive the task field from what was actually painted, not from a
            // guessed 34-column reservation that overflowed narrow screens.
            const rowTaskWidth = Math.max(1, cols - usedWithoutTail - displayWidth(tail));
            return (
              <Box key={item.id} flexDirection="row">
                <Text color={theme[STATUS_COLOR_KEY[item.status]]}>{icon}</Text>
                <Text color={theme.dim} wrap="truncate-end">{id}</Text>
                {badge ? <Text color={theme.accent} wrap="truncate-end">{badge}</Text> : null}
                <Text color={theme.text} wrap="truncate-end">{truncate(item.task, rowTaskWidth)}</Text>
                <Text color={theme.dim} wrap="truncate-end">{tail}</Text>
              </Box>
            );
          })}
        </Box>
      </LeftBar>
    </Box>
  );
};

/**
 * Sub-agent transcript persistence.
 *
 * Each child agent run is stored as its own readable transcript under
 * `~/.local/share/bitacode/subagents/<mainSessionId>/<subAgentId>.json` so
 * the main agent can inspect what a child did via the `read_subagent` tool.
 *
 * Mirrors sessions.ts conventions: 0700 dirs, 0600 files. Every public
 * function is best-effort — it logs and returns false/null/[] on error and
 * never throws into a caller.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chmodSync } from 'node:fs';
import type { UsageInfo } from './cost-tracker.js';
import { logger } from './logger.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ID_PATTERN = /^[A-Za-z0-9-]+$/;
const MAX_MESSAGES = 100;
const MAX_CONTENT_CHARS = 8_000;
const MAX_TEXT_CHARS = 2_000;

export type SubAgentRunStatus = 'done' | 'aborted' | 'error' | 'iteration_limit';

const STATUSES = new Set<SubAgentRunStatus>(['done', 'aborted', 'error', 'iteration_limit']);

/** Normalized, safe-to-render message stored in a transcript. */
export interface SubAgentMessage {
  role: string;
  content: string;
}

export interface SubAgentRunSummary {
  id: string;
  sessionId: string;
  task: string;
  label?: string;
  status: SubAgentRunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  messageCount: number;
}

export interface SubAgentRunRecord extends SubAgentRunSummary {
  messages: SubAgentMessage[];
  usage?: UsageInfo;
}

/** Save accepts raw LLM messages (any shape); they are normalized on write. */
export type SubAgentRunInput = {
  sessionId: string;
  id: string;
  task: string;
  label?: string;
  status: SubAgentRunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  usage?: UsageInfo;
  messageCount?: number;
  messages: readonly unknown[];
};

/** Ids are alphanumeric or dashes only — no separators or dots, so no traversal. */
export function isValidSubAgentId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function hardenPermissions(targetPath: string, mode: number): void {
  if (process.platform === 'win32') return;
  chmodSync(targetPath, mode);
}

function getSubagentsDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'bitacode', 'subagents');
  }
  return path.join(home, '.local', 'share', 'bitacode', 'subagents');
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 16))}...[truncated]`;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitizeMessages(value: unknown): SubAgentMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: SubAgentMessage[] = [];
  for (const raw of value.slice(-MAX_MESSAGES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const message = raw as { role?: unknown; content?: unknown };
    if (typeof message.role !== 'string' || message.role.length === 0) continue;
    messages.push({
      role: message.role,
      content: cap(toText(message.content), MAX_CONTENT_CHARS),
    });
  }
  return messages;
}

function sanitizeUsage(value: unknown): UsageInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const num = (key: string): number =>
    typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : 0;
  return {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    totalTokens: num('totalTokens'),
    estimatedCost: num('estimatedCost'),
  };
}

/** Drop malformed records instead of letting them crash a reader. */
function sanitizeRecord(value: unknown): SubAgentRunRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isValidSubAgentId(record.id) || !isValidSubAgentId(record.sessionId)) return null;
  if (typeof record.task !== 'string') return null;
  if (typeof record.status !== 'string' || !STATUSES.has(record.status as SubAgentRunStatus)) return null;
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) return null;

  const messages = sanitizeMessages(record.messages);
  const sanitized: SubAgentRunRecord = {
    id: record.id,
    sessionId: record.sessionId,
    task: cap(record.task, MAX_TEXT_CHARS),
    status: record.status as SubAgentRunStatus,
    startedAt: record.startedAt,
    messageCount: messages.length,
    messages,
  };
  if (typeof record.label === 'string') sanitized.label = cap(record.label, MAX_TEXT_CHARS);
  if (typeof record.endedAt === 'number' && Number.isFinite(record.endedAt)) {
    sanitized.endedAt = record.endedAt;
  }
  if (typeof record.error === 'string') sanitized.error = cap(record.error, MAX_TEXT_CHARS);
  const usage = sanitizeUsage(record.usage);
  if (usage) sanitized.usage = usage;
  return sanitized;
}

/**
 * Save one child run. Returns false (never throws) if ids or payload are
 * invalid, or if the disk write fails.
 */
export async function saveSubAgentRun(record: SubAgentRunInput): Promise<boolean> {
  try {
    if (!record || !isValidSubAgentId(record.sessionId) || !isValidSubAgentId(record.id)) {
      logger.warn('Sub-agent store: invalid id on save', { sessionId: record?.sessionId, id: record?.id });
      return false;
    }
    const sanitized = sanitizeRecord(record);
    if (!sanitized) {
      logger.warn('Sub-agent store: invalid record on save', { sessionId: record.sessionId, id: record.id });
      return false;
    }
    const sessionDir = path.join(getSubagentsDir(), record.sessionId);
    await fs.mkdir(sessionDir, { recursive: true, mode: DIR_MODE });
    hardenPermissions(sessionDir, DIR_MODE);
    const filePath = path.join(sessionDir, `${record.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: FILE_MODE });
    hardenPermissions(filePath, FILE_MODE);
    logger.debug('Sub-agent transcript saved', { sessionId: record.sessionId, id: record.id });
    return true;
  } catch (err) {
    logger.warn('Sub-agent store: failed to save transcript', { err: String(err) });
    return false;
  }
}

/** List summaries of all child runs for a session, newest first. */
export async function listSubAgentRuns(sessionId: string): Promise<SubAgentRunSummary[]> {
  try {
    if (!isValidSubAgentId(sessionId)) return [];
    const sessionDir = path.join(getSubagentsDir(), sessionId);
    const entries = await fs.readdir(sessionDir);
    const summaries: SubAgentRunSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!isValidSubAgentId(id)) continue;
      try {
        const content = await fs.readFile(path.join(sessionDir, entry), 'utf8');
        const record = sanitizeRecord(JSON.parse(content));
        if (!record || record.id !== id) continue;
        const { messages: _messages, ...summary } = record;
        summaries.push(summary);
      } catch {
        // Skip a corrupt or unreadable transcript file.
      }
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  } catch (err) {
    logger.warn('Sub-agent store: failed to list transcripts', { sessionId, err: String(err) });
    return [];
  }
}

/** Load one full transcript; null when missing, invalid, or unreadable. */
export async function loadSubAgentRun(sessionId: string, id: string): Promise<SubAgentRunRecord | null> {
  try {
    if (!isValidSubAgentId(sessionId) || !isValidSubAgentId(id)) return null;
    const content = await fs.readFile(path.join(getSubagentsDir(), sessionId, `${id}.json`), 'utf8');
    const record = sanitizeRecord(JSON.parse(content));
    if (!record || record.id !== id) return null;
    return record;
  } catch (err) {
    logger.warn('Sub-agent store: failed to load transcript', { sessionId, id, err: String(err) });
    return null;
  }
}

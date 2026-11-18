/**
 * Session persistence — Save and load conversation history.
 *
 * Sessions are stored as JSON files in `~/.local/share/bitacode/sessions/`.
 * Each session has a unique ID, a title, and the full message history.
 *
 * The agent can resume a previous session or start a new one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chmodSync } from 'node:fs';
import type OpenAI from 'openai';
import { clearTodos, type TodoItem } from './tools/todo.js';
import { logger } from './utils/logger.js';

const SESSION_DIR_MODE = 0o700;
const SESSION_FILE_MODE = 0o600;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID_PATTERN = /^[0-9a-z]{8}$/i;

function hardenPermissions(targetPath: string, mode: number): void {
  if (process.platform === 'win32') return;
  chmodSync(targetPath, mode);
}

function isValidSessionId(id: string): boolean {
  // Accept both legacy UUIDs and new short IDs. The patterns include no path
  // separators or dots, so an accepted id can never escape the sessions dir.
  return SESSION_ID_PATTERN.test(id) || SHORT_ID_PATTERN.test(id);
}

function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
}

/** Generate a short, readable session ID (8 alphanumeric characters). */
function generateSessionId(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/** One step of a parallel sub-agent, persisted so resumed sessions can replay it. */
export interface SubAgentActivity {
  id: string;
  task: string;
  status: 'start' | 'done' | 'error';
  toolCalls?: number;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: string;
  /** Reasoning variant active when the session was last used. */
  variant?: string;
  todos: TodoItem[];
  completionMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** Parallel sub-agent steps recorded during the session. */
  subAgentActivities?: SubAgentActivity[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  messageCount: number;
}

/** True once the transcript has anything beyond the system prompt. */
export function hasConversationMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): boolean {
  return messages.some((message) => message.role !== 'system');
}

export function ensureSystemPromptAtTop(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  systemPrompt: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const firstSystemIndex = messages.findIndex((message) => message.role === 'system');

  if (firstSystemIndex === -1) {
    return [{ role: 'system', content: systemPrompt } as OpenAI.Chat.Completions.ChatCompletionMessageParam, ...messages];
  }

  const firstSystemMessage = messages[firstSystemIndex] as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  const normalizedSystemMessage = {
    ...firstSystemMessage,
    role: 'system',
    content: systemPrompt,
  } as OpenAI.Chat.Completions.ChatCompletionMessageParam;

  return [
    normalizedSystemMessage,
    ...messages.slice(0, firstSystemIndex),
    ...messages.slice(firstSystemIndex + 1),
  ];
}

/**
 * Repair histories that older builds or interrupted turns may leave invalid:
 * an assistant tool call without a result, an orphaned tool result, or an
 * empty assistant message. Providers reject all three, which used to make a
 * resumed session fail every request.
 */
export function sanitizeCompletionMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const sanitized: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index] as any;

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      index++;
      continue;
    }

    if (message.role === 'assistant') {
      const content = message.content;
      const hasContent =
        (typeof content === 'string' && content.trim().length > 0) ||
        (Array.isArray(content) && content.length > 0);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.filter(
            (call: any) =>
              call &&
              typeof call.id === 'string' &&
              call.id.length > 0 &&
              call.function &&
              typeof call.function.name === 'string'
          )
        : [];

      // Reasoning is a UI-only field, but it must survive save/load so a
      // resumed session can replay the thought above its answer.
      const reasoning: Record<string, string> = typeof message.reasoning === 'string'
        ? { reasoning: message.reasoning.slice(0, 20_000) }
        : {};

      if (toolCalls.length === 0) {
        // An empty assistant message is not valid history.
        if (hasContent) {
          const { tool_calls: _ignored, reasoning: _savedReasoning, ...rest } = message;
          sanitized.push({ ...rest, ...reasoning } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        }
        index++;
        continue;
      }

      sanitized.push({ ...message, ...reasoning, tool_calls: toolCalls });
      index++;

      const answered = new Set<string>();
      while (index < messages.length && (messages[index] as any).role === 'tool') {
        const toolMessage = messages[index] as any;
        const id = toolMessage.tool_call_id;
        if (
          typeof id === 'string' &&
          toolCalls.some((call: any) => call.id === id) &&
          !answered.has(id)
        ) {
          answered.add(id);
          sanitized.push({
            ...toolMessage,
            content: typeof toolMessage.content === 'string' ? toolMessage.content : String(toolMessage.content ?? ''),
          });
        }
        index++;
      }

      // Keep every tool call paired with a result. A missing result happens
      // when a turn is saved mid-execution; the provider would reject it.
      for (const call of toolCalls) {
        if (!answered.has(call.id)) {
          sanitized.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Tool result was missing from the saved session. Re-run the tool if needed.',
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
        }
      }
      continue;
    }

    // A tool result outside an assistant tool_calls group is orphaned.
    if (message.role !== 'tool') {
      sanitized.push(message);
    }
    index++;
  }

  return sanitized;
}

function getSessionsDir(): string {
  const homeDir = os.homedir();
  if (process.platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Local', 'bitacode', 'sessions');
  }
  return path.join(homeDir, '.local', 'share', 'bitacode', 'sessions');
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed', 'cancelled']);
const TODO_PRIORITIES = new Set<TodoItem['priority']>(['high', 'medium', 'low']);

/** Drop malformed persisted todos instead of letting them crash the panel. */
function sanitizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const todo = item as Partial<TodoItem>;
    if (
      typeof todo.id !== 'string' ||
      typeof todo.content !== 'string' ||
      !TODO_STATUSES.has(todo.status as TodoItem['status']) ||
      !TODO_PRIORITIES.has(todo.priority as TodoItem['priority'])
    ) {
      continue;
    }
    todos.push({
      id: todo.id,
      content: todo.content,
      status: todo.status as TodoItem['status'],
      priority: todo.priority as TodoItem['priority'],
    });
  }
  return todos;
}

const SUB_AGENT_STATUSES = new Set<SubAgentActivity['status']>(['start', 'done', 'error']);
const MAX_SUB_AGENT_ACTIVITIES = 50;

/**
 * Drop malformed persisted sub-agent activity instead of crashing a resumed
 * session. Missing/invalid input stays undefined so old sessions are unchanged.
 */
function sanitizeSubAgentActivities(value: unknown): SubAgentActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const activities: SubAgentActivity[] = [];
  for (const item of value) {
    if (activities.length >= MAX_SUB_AGENT_ACTIVITIES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const activity = item as Partial<SubAgentActivity>;
    const endedAtOk =
      activity.endedAt === undefined ||
      (typeof activity.endedAt === 'number' && Number.isFinite(activity.endedAt));
    const toolCallsOk =
      activity.toolCalls === undefined ||
      (typeof activity.toolCalls === 'number' &&
        Number.isInteger(activity.toolCalls) &&
        activity.toolCalls >= 0);
    const summaryOk = activity.summary === undefined || typeof activity.summary === 'string';
    if (
      typeof activity.id !== 'string' ||
      activity.id.length === 0 ||
      typeof activity.task !== 'string' ||
      activity.task.length === 0 ||
      !SUB_AGENT_STATUSES.has(activity.status as SubAgentActivity['status']) ||
      typeof activity.startedAt !== 'number' ||
      !Number.isFinite(activity.startedAt) ||
      !endedAtOk ||
      !toolCallsOk ||
      !summaryOk
    ) {
      continue;
    }
    const sanitized: SubAgentActivity = {
      id: activity.id,
      task: activity.task,
      status: activity.status as SubAgentActivity['status'],
      startedAt: activity.startedAt,
    };
    if (typeof activity.endedAt === 'number') sanitized.endedAt = activity.endedAt;
    if (typeof activity.toolCalls === 'number') sanitized.toolCalls = activity.toolCalls;
    if (typeof activity.summary === 'string') sanitized.summary = activity.summary;
    activities.push(sanitized);
  }
  return activities;
}

async function ensureSessionsDir(): Promise<string> {
  const dir = getSessionsDir();
  await fs.mkdir(dir, { recursive: true, mode: SESSION_DIR_MODE });
  hardenPermissions(dir, SESSION_DIR_MODE);
  return dir;
}

function sessionPath(id: string): string {
  assertValidSessionId(id);
  return path.join(getSessionsDir(), `${id}.json`);
}

/** Create a new session. */
export function createSession(model: string, provider: string): Session {
  return {
    id: generateSessionId(),
    title: 'New session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model,
    provider,
    todos: [],
    completionMessages: [],
  };
}

/** Save a session to disk. */
export async function saveSession(session: Session): Promise<void> {
  await ensureSessionsDir();
  session.updatedAt = new Date().toISOString();
  const filePath = sessionPath(session.id);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: SESSION_FILE_MODE });
  hardenPermissions(filePath, SESSION_FILE_MODE);
  logger.debug(`Session saved: ${session.id}`);
}

/** Load a session by ID. Returns null if not found. */
export async function loadSession(id: string): Promise<Session | null> {
  try {
    const content = await fs.readFile(sessionPath(id), 'utf8');
    const session = JSON.parse(content) as Partial<Session>;
    return {
      id: typeof session.id === 'string' ? session.id : id,
      title: typeof session.title === 'string' ? session.title : 'New session',
      createdAt: typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
      model: typeof session.model === 'string' ? session.model : '',
      provider: typeof session.provider === 'string' ? session.provider : '',
      variant: typeof session.variant === 'string' ? session.variant : undefined,
      todos: sanitizeTodos(session.todos),
      completionMessages: sanitizeCompletionMessages(
        Array.isArray(session.completionMessages) ? session.completionMessages : []
      ),
      subAgentActivities: sanitizeSubAgentActivities(session.subAgentActivities),
    };
  } catch {
    return null;
  }
}

/** List all sessions (sorted by most recently updated). */
export async function listSessions(): Promise<SessionSummary[]> {
  const dir = getSessionsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    // The id must match the filename so every listed session can be deleted;
    // a stored id that differs from its filename is ignored.
    const id = entry.replace(/\.json$/, '');
    if (!isValidSessionId(id)) continue;
    try {
      const content = await fs.readFile(path.join(dir, entry), 'utf8');
      const session = JSON.parse(content) as Session;
      summaries.push({
        id,
        title: typeof session.title === 'string' ? session.title : 'New session',
        createdAt: typeof session.createdAt === 'string' ? session.createdAt : '',
        updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
        provider: typeof session.provider === 'string' ? session.provider : undefined,
        model: typeof session.model === 'string' ? session.model : undefined,
        messageCount: Array.isArray(session.completionMessages) ? session.completionMessages.length : 0,
      });
    } catch {
      // Skip corrupt session files
    }
  }

  // Sort by most recently updated
  summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return summaries;
}

/** Delete a session and all of its associated in-memory state. */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(id));
    // Todos are persisted inside the session JSON (removed above); this clears
    // the separate in-memory copy so a deleted session leaves nothing behind.
    clearTodos(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a short title for a session from the first user message.
 * Uses the LLM to summarise if the message is long.
 */
export function generateTitle(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (!firstUserMsg || !('content' in firstUserMsg) || typeof firstUserMsg.content !== 'string') {
    return 'New session';
  }
  const content = firstUserMsg.content;
  // Simple heuristic: take first 60 chars of the first user message
  if (content.length <= 60) return content;
  return content.slice(0, 57) + '...';
}

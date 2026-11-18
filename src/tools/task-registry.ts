/**
 * Shared in-memory registries, caps, types, and formatting helpers for the
 * task tools. Deliberately free of any import from `tools/index.ts` so the
 * central registry can wire these tools without creating a circular import.
 */

export interface TaskToolContext {
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export const DEFAULT_SESSION_ID = '__default__';
export const MAX_OUTPUT_CHARS = 12_000;
export const MAX_REGISTRY_ENTRIES = 100;

export function cap(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 16))}...[truncated]`;
}

export function errorMessage(tool: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error in ${tool}: ${msg}`;
}

export function sessionKey(sessionId?: string): string {
  return sessionId && sessionId.trim() ? sessionId.trim() : DEFAULT_SESSION_ID;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export const MAX_PLAN_STEPS = 50;
export const MAX_STEP_CHARS = 500;
export const MAX_GOAL_CHARS = 1_000;
export const MAX_NOTES_CHARS = 2_000;

export interface PlanRecord {
  goal: string;
  steps: string[];
  notes?: string;
  createdAt: number;
}

export interface PlanArgs {
  goal?: unknown;
  steps?: unknown;
  notes?: unknown;
}

export const plansBySession = new Map<string, PlanRecord>();

// ---------------------------------------------------------------------------
// parallel
// ---------------------------------------------------------------------------

export const MAX_PARALLEL_CALLS = 8;
export const MAX_PARALLEL_CONCURRENCY = 4;
export const MAX_SINGLE_RESULT_CHARS = 4_000;

export interface ParallelCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParallelArgs {
  calls?: unknown;
}

export type ParallelExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: TaskToolContext,
) => Promise<string> | string;

// ---------------------------------------------------------------------------
// agent_status / agent_message
// ---------------------------------------------------------------------------

export interface SubAgentStatusEntry {
  id: string;
  task: string;
  status: string;
  toolCount: number;
  updatedAt: number;
}

export const statusRegistry = new Map<string, SubAgentStatusEntry>();
export const queuedMessages = new Map<string, string[]>();

export const MAX_STATUS_ROWS = 25;
export const MAX_QUEUED_PER_AGENT = 50;
export const MAX_MESSAGE_CHARS = 2_000;

export interface AgentStatusArgs {
  id?: unknown;
}

export interface AgentMessageArgs {
  id?: unknown;
  message?: unknown;
}

// ---------------------------------------------------------------------------
// task_result
// ---------------------------------------------------------------------------

export const MAX_TRANSCRIPT_PREVIEW = 20;
export const MAX_PREVIEW_CHARS = 300;

export interface TaskResultArgs {
  id?: unknown;
  session_id?: unknown;
}

// ---------------------------------------------------------------------------
// notify / progress / open_url
// ---------------------------------------------------------------------------

export const MAX_NOTIFY_CHARS = 500;
export const MAX_PROGRESS_LABEL_CHARS = 200;
export const PROGRESS_WIDTH = 10;
export const OPEN_URL_TIMEOUT_MS = 5_000;

export interface NotifyArgs {
  message?: unknown;
  title?: unknown;
}

export interface ProgressArgs {
  percent?: unknown;
  label?: unknown;
}

export interface ParsedProgress {
  percent: number;
  label: string;
}

export interface OpenUrlArgs {
  url?: unknown;
}

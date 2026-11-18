/**
 * Shared in-memory registries, caps, types, and formatting helpers for the
 * task tools. Deliberately free of any import from `tools/index.ts` so the
 * central registry can wire these tools without creating a circular import.
 */
export const DEFAULT_SESSION_ID = '__default__';
export const MAX_OUTPUT_CHARS = 12_000;
export const MAX_REGISTRY_ENTRIES = 100;
export function cap(text, max = MAX_OUTPUT_CHARS) {
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 16))}...[truncated]`;
}
export function errorMessage(tool, err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error in ${tool}: ${msg}`;
}
export function sessionKey(sessionId) {
    return sessionId && sessionId.trim() ? sessionId.trim() : DEFAULT_SESSION_ID;
}
// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
export const MAX_PLAN_STEPS = 50;
export const MAX_STEP_CHARS = 500;
export const MAX_GOAL_CHARS = 1_000;
export const MAX_NOTES_CHARS = 2_000;
export const plansBySession = new Map();
// ---------------------------------------------------------------------------
// parallel
// ---------------------------------------------------------------------------
export const MAX_PARALLEL_CALLS = 8;
export const MAX_PARALLEL_CONCURRENCY = 4;
export const MAX_SINGLE_RESULT_CHARS = 4_000;
export const statusRegistry = new Map();
export const queuedMessages = new Map();
export const MAX_STATUS_ROWS = 25;
export const MAX_QUEUED_PER_AGENT = 50;
export const MAX_MESSAGE_CHARS = 2_000;
// ---------------------------------------------------------------------------
// task_result
// ---------------------------------------------------------------------------
export const MAX_TRANSCRIPT_PREVIEW = 20;
export const MAX_PREVIEW_CHARS = 300;
// ---------------------------------------------------------------------------
// notify / progress / open_url
// ---------------------------------------------------------------------------
export const MAX_NOTIFY_CHARS = 500;
export const MAX_PROGRESS_LABEL_CHARS = 200;
export const PROGRESS_WIDTH = 10;
export const OPEN_URL_TIMEOUT_MS = 5_000;

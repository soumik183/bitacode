/**
 * working-checkpoint.ts — a model-curated notepad that survives compaction.
 *
 * The model writes it with the `update_working_checkpoint` tool; the loop pins
 * the latest content into the conversation before every request. Unlike `todo`
 * (a plan) and `/undo` (file history) this is durable task memory: what was
 * learned, which approach was rejected and why, what the next concrete step is.
 *
 * The cap is the point: a notepad that can grow without bound becomes the very
 * context problem it exists to solve.
 */

/** Hard cap on checkpoint characters; roughly 1k tokens. */
export const MAX_CHECKPOINT_CHARS = 4_000;

const checkpoints = new Map<string, string>();

function key(sessionId?: string): string {
  return sessionId && sessionId.trim() ? sessionId.trim() : 'default';
}

/**
 * Normalise model-supplied content: trim trailing whitespace, drop blank input
 * (which clears the checkpoint), and cap the length with an explicit marker.
 */
export function applyWorkingCheckpoint(content: unknown): string {
  if (typeof content !== 'string') return '';
  const trimmed = content.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return '';
  if (trimmed.length <= MAX_CHECKPOINT_CHARS) return trimmed;
  const marker = `\n…[truncated; keep the checkpoint under ${MAX_CHECKPOINT_CHARS} characters]`;
  return trimmed.slice(0, MAX_CHECKPOINT_CHARS - marker.length) + marker;
}

export function setWorkingCheckpoint(sessionId: string | undefined, content: unknown): string {
  const next = applyWorkingCheckpoint(content);
  if (next) checkpoints.set(key(sessionId), next);
  else checkpoints.delete(key(sessionId));
  return next;
}

export function getWorkingCheckpoint(sessionId?: string): string {
  return checkpoints.get(key(sessionId)) ?? '';
}

export function clearWorkingCheckpoint(sessionId?: string): void {
  if (sessionId === undefined) checkpoints.clear();
  else checkpoints.delete(key(sessionId));
}

/** Frame injected before each request; empty string when the checkpoint is blank. */
export function workingCheckpointFrame(sessionId?: string): string {
  const content = getWorkingCheckpoint(sessionId);
  if (!content) return '';
  return [
    'Working checkpoint (your own notes from earlier in this task; rewrite it with update_working_checkpoint):',
    content,
  ].join('\n');
}

/** Tool description shown to the model, kept short on purpose. */
export const WORKING_CHECKPOINT_TOOL_DESCRIPTION =
  'Replace your working checkpoint: a short notepad of durable facts, decisions and the next step. '
  + 'Re-injected every turn and kept across compaction. Empty string clears it.';

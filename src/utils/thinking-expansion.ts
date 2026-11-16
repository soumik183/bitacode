/**
 * Thinking panel expansion policy.
 *
 * The live reasoning block should be readable while the model is thinking and
 * should shrink to a plain one-line header once thinking ends. A manual toggle
 * (ctrl+t or a mouse click) wins until the next reasoning phase starts, so the
 * panel never reopens or collapses under the user's cursor mid-read.
 */
export interface ThinkingExpansionState {
  /** Whether a reasoning phase is currently live. */
  active: boolean;
  /** Whether the user toggled the block by hand during this phase. */
  pinned: boolean;
  /** Current expanded flag. */
  expanded: boolean;
}

export interface ThinkingExpansionInput {
  /** Whether a reasoning phase is live in the render that just happened. */
  active: boolean;
  /** Same value from the previous render; used to detect the phase boundary. */
  wasActive: boolean;
  pinned: boolean;
  expanded: boolean;
}

export interface ThinkingExpansionResult {
  expanded: boolean;
  pinned: boolean;
}

/**
 * Decide the next expansion state when the "reasoning is live" flag changes.
 *
 * - reasoning starts  -> expand and clear any stale manual pin
 * - reasoning ends    -> collapse, unless the user pinned it this phase
 * - no change         -> leave everything untouched
 */
export function nextThinkingExpansion({
  active,
  wasActive,
  pinned,
  expanded,
}: ThinkingExpansionInput): ThinkingExpansionResult {
  if (active === wasActive) {
    return { expanded, pinned };
  }
  if (active) {
    return { expanded: true, pinned: false };
  }
  if (pinned) {
    return { expanded, pinned };
  }
  return { expanded: false, pinned };
}

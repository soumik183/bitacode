/**
 * Bounded goal / supervisor evaluation for the agentic loop.
 *
 * Pure logic only: this module never calls a provider. The loop supplies the
 * model's answer text, and this module turns it into a fresh `GoalState`.
 * A pass is terminal, issues consume one round of the budget, and running out
 * of rounds turns the next ISSUES verdict into a `fail`.
 *
 * Nothing here throws: malformed input is sanitized and reported through the
 * logger so a bad goal or verdict cannot take down the TUI event loop.
 */

import { logger } from './logger.js';

export interface GoalState {
  /** Sanitized objective (1..2000 chars for a valid goal). */
  goal: string;
  /** Number of completed rounds, clamped to [0, maxRounds]. */
  rounds: number;
  /** Round budget, clamped to [1, 12]. */
  maxRounds: number;
  /** Round summaries, oldest first, capped at 12 entries. */
  history: string[];
  /** Terminal states are pass, fail and stopped; working continues the loop. */
  verdict: 'working' | 'pass' | 'fail' | 'stopped';
}

const DEFAULT_MAX_ROUNDS = 5;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 12;
const MAX_GOAL_CHARS = 2000;
const MAX_SUMMARY_CHARS = 1000;
const MAX_HISTORY_ENTRIES = 12;
const PROMPT_HISTORY_ROUNDS = 3;
const PROMPT_HISTORY_CHARS = 500;
const VERDICT_WINDOW_CHARS = 500;

/** C0/C1 controls plus DEL: these must never reach a prompt or a log line. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/**
 * Exact marker, case-insensitive. The trailing lookahead rejects word
 * continuations (PASSED, ISSUES-FOUND) while still allowing punctuation.
 */
const VERDICT_MARKER = /\bVERDICT:\s*(PASS|ISSUES)(?![A-Za-z0-9_-])/gi;

function sanitize(value: unknown): string {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '') : '';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stoppedGoal(
  maxRounds: number,
  reason: string,
  message = 'Invalid goal supplied; stopping goal loop'
): GoalState {
  logger.warn(message, { reason });
  return { goal: '', rounds: 0, maxRounds, history: ['invalid goal'], verdict: 'stopped' };
}

/**
 * Start a goal loop. Control chars are stripped and the goal is trimmed; a
 * goal outside 1..2000 chars is invalid and returns a `stopped` state with
 * `history: ['invalid goal']` (never an exception) so the UI can show the error.
 * `maxRounds` is clamped to 1..12 and defaults to 5.
 */
export function createGoal(goal: string, options?: { maxRounds?: number }): GoalState {
  let maxRounds = DEFAULT_MAX_ROUNDS;
  try {
    maxRounds = clampInt(options?.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    const clean = sanitize(goal).trim();
    if (!clean || clean.length > MAX_GOAL_CHARS) {
      return stoppedGoal(maxRounds, clean ? 'goal too long' : 'goal empty');
    }
    return { goal: clean, rounds: 0, maxRounds, history: [], verdict: 'working' };
  } catch (err) {
    logger.warn('Could not create goal state', { error: String(err) });
    return stoppedGoal(maxRounds, 'unexpected error');
  }
}

/**
 * Compact instruction for the current supervisor round. Shows the goal, the
 * upcoming round number and at most the last three summaries (500 chars each).
 */
export function renderGoalPrompt(state: GoalState): string {
  try {
    const goal = sanitize(state?.goal).trim() || '(no goal)';
    const maxRounds = clampInt(state?.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    const round = clampInt((state?.rounds ?? 0) + 1, MIN_MAX_ROUNDS, maxRounds, MIN_MAX_ROUNDS);
    const lines = [
      `Goal: ${goal}`,
      'Continue until the goal is met; do not stop while issues remain.',
      'End your answer with exactly one marker: VERDICT: PASS (met) or VERDICT: ISSUES (work remains).',
      `Round ${round}/${maxRounds}`,
    ];

    const history = Array.isArray(state?.history) ? state.history.slice(-PROMPT_HISTORY_ROUNDS) : [];
    if (history.length > 0) {
      lines.push('Recent rounds (oldest first):');
      for (const entry of history) {
        const line = sanitize(entry).trim().slice(0, PROMPT_HISTORY_CHARS);
        if (line) lines.push(`- ${line}`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    logger.warn('Could not render goal prompt', { error: String(err) });
    return 'Continue until the goal is met. End with VERDICT: PASS or VERDICT: ISSUES.';
  }
}

/**
 * Read the verdict from the last 500 chars only. Matching is case-insensitive
 * and punctuation after PASS/ISSUES is fine. Two markers in the window are
 * ambiguous and yield `undefined` (the loop keeps working).
 */
export function parseVerdict(text: string): 'pass' | 'issues' | undefined {
  try {
    if (typeof text !== 'string') return undefined;
    const tail = text.slice(-VERDICT_WINDOW_CHARS);
    let found: 'pass' | 'issues' | undefined;
    let count = 0;
    for (const match of tail.matchAll(VERDICT_MARKER)) {
      count += 1;
      if (count > 1) return undefined;
      found = match[1].toUpperCase() === 'PASS' ? 'pass' : 'issues';
    }
    return found;
  } catch (err) {
    logger.warn('Could not parse goal verdict', { error: String(err) });
    return undefined;
  }
}

/**
 * Record one round immutably. PASS is terminal; ISSUES is `working` below the
 * budget and `fail` once `rounds >= maxRounds`; a missing verdict is `working`.
 * Summaries are control-char-free and truncated to 1000 chars; history keeps
 * the last 12 entries.
 */
export function recordRound(state: GoalState, summary: string, verdictText?: string): GoalState {
  try {
    const maxRounds = clampInt(state?.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    const rounds = Math.min(maxRounds, clampInt(state?.rounds, 0, MAX_MAX_ROUNDS, 0) + 1);
    const cleanSummary = sanitize(summary).trim().slice(0, MAX_SUMMARY_CHARS);
    const previous = Array.isArray(state?.history)
      ? state.history.map(entry => sanitize(entry).trim())
      : [];
    const history = [...previous, cleanSummary].slice(-MAX_HISTORY_ENTRIES);

    const parsed = parseVerdict(verdictText ?? '');
    const verdict: GoalState['verdict'] =
      parsed === 'pass'
        ? 'pass'
        : parsed === 'issues'
          ? rounds >= maxRounds
            ? 'fail'
            : 'working'
          : 'working';

    return { goal: sanitize(state?.goal).trim(), rounds, maxRounds, history, verdict };
  } catch (err) {
    logger.warn('Could not record goal round', { error: String(err) });
    return stoppedGoal(DEFAULT_MAX_ROUNDS, 'unexpected error', 'Goal round failed; stopping goal loop');
  }
}

/** Short XML-ish system-prompt block, empty once the loop is stopped or failed. */
export function goalContextBlock(state: GoalState): string {
  if (!state || (state.verdict !== 'working' && state.verdict !== 'pass')) return '';
  try {
    const goal = sanitize(state.goal).trim() || '(no goal)';
    const maxRounds = clampInt(state.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
    const round = clampInt(state.rounds, 0, maxRounds, 0);
    return [
      `<goal status="${state.verdict}" round="${round}/${maxRounds}">`,
      escapeXml(goal),
      '</goal>',
    ].join('\n');
  } catch (err) {
    logger.warn('Could not render goal context block', { error: String(err) });
    return '';
  }
}

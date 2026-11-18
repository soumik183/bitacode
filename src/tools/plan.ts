import {
  cap,
  errorMessage,
  MAX_GOAL_CHARS,
  MAX_NOTES_CHARS,
  MAX_PLAN_STEPS,
  MAX_STEP_CHARS,
  plansBySession,
  sessionKey,
  type PlanArgs,
  type PlanRecord,
  type TaskToolContext,
} from './task-registry.js';

/** Snapshot of the last plan created for a session (null when none). */
export function getPlanForSession(sessionId?: string): PlanRecord | null {
  const plan = plansBySession.get(sessionKey(sessionId));
  return plan ? { ...plan, steps: [...plan.steps] } : null;
}

export const planTool = {
  type: 'function' as const,
  function: {
    name: 'plan',
    description: 'Create and store a structured implementation plan for the current session. Returns a Markdown checklist.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the plan is meant to achieve.' },
        steps: {
          type: 'array',
          description: `Ordered implementation steps (max ${MAX_PLAN_STEPS}).`,
          items: { type: 'string' },
        },
        notes: { type: 'string', description: 'Optional constraints or context.' },
      },
      required: ['goal', 'steps'],
    },
  },
};

export async function plan(args: PlanArgs = {}, context: TaskToolContext = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const goal = typeof a.goal === 'string' ? a.goal.trim().slice(0, MAX_GOAL_CHARS) : '';
    if (!goal) return 'Error: goal must be a non-empty string.';
    if (!Array.isArray(a.steps)) return 'Error: steps must be an array of strings.';
    if (a.steps.length === 0) return 'Error: steps must contain at least one step.';
    if (a.steps.length > MAX_PLAN_STEPS) {
      return `Error: too many steps (${a.steps.length}); the limit is ${MAX_PLAN_STEPS}.`;
    }

    const steps: string[] = [];
    for (let i = 0; i < a.steps.length; i++) {
      const raw: unknown = a.steps[i];
      if (typeof raw !== 'string' || !raw.trim()) return `Error: step ${i + 1} must be a non-empty string.`;
      steps.push(raw.trim().slice(0, MAX_STEP_CHARS));
    }
    const notes = typeof a.notes === 'string' && a.notes.trim()
      ? a.notes.trim().slice(0, MAX_NOTES_CHARS)
      : undefined;

    const record: PlanRecord = { goal, steps, ...(notes ? { notes } : {}), createdAt: Date.now() };
    plansBySession.set(sessionKey(context.sessionId), record);

    const lines = steps.map((step, i) => `${i + 1}. [ ] ${step}`);
    return cap(`# Implementation Plan\nGoal: ${goal}\n\n${lines.join('\n')}${notes ? `\n\nNotes: ${notes}` : ''}`);
  } catch (err) {
    return errorMessage('plan', err);
  }
}

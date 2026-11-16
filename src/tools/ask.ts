/**
 * ask_user tool — the agent pauses to ask the human a question.
 *
 * Two shapes, both resolved through a handler the Ink UI registers:
 *  - single: one question, answered by typed text or by picking an option
 *  - multi:  several questions, asked one at a time, answered as a group
 *
 * Options are optional. When the model supplies them they are rendered as a
 * selectable list ("recommended" entries first), which is much faster to
 * answer on a phone than typing. Free-form typing is always available, so a
 * list never traps the user into a fixed answer.
 */

export interface AskOption {
  label: string;
  description?: string;
  /** The agent's own recommendation; rendered first and marked. */
  recommended?: boolean;
}

export interface AskQuestion {
  id?: string;
  question: string;
  /** Optional short context shown under the question. */
  context?: string;
  /** Optional quick answers. Empty means free-text only. */
  options?: AskOption[];
  /** Allow more than one option to be selected. */
  multiple?: boolean;
  /** Allow a free-text answer in addition to the options. */
  allow_free_text?: boolean;
}

export interface AskRequest {
  /** One or more questions. A single question is the common case. */
  questions: AskQuestion[];
  sessionId?: string;
}

export interface AskAnswer {
  id: string;
  question: string;
  answer: string;
}

export type AskResponse = AskAnswer[];

/** Handler registered by the UI. Resolves with the collected answers. */
let askHandler: ((request: AskRequest) => Promise<AskResponse>) | null = null;

export function setAskHandler(handler: (request: AskRequest) => Promise<AskResponse>): void {
  askHandler = handler;
}

export function clearAskHandler(): void {
  askHandler = null;
}

export function hasAskHandler(): boolean {
  return askHandler !== null;
}

export const askQuestionTool = {
  type: 'function' as const,
  function: {
    name: 'ask_user',
    description:
      'Ask the user a question and wait for their answer. Use this instead of guessing when a decision is ambiguous, when you need a preference, or when several reasonable options exist. Pass one question for a simple prompt, or several to collect answers in one go. Supply `options` with the choices you recommend so the user can answer with a single keypress; they can still type their own answer.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'One or more questions. One question is the common case.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable id, e.g. "approach". Optional.' },
              question: { type: 'string', description: 'The question to ask.' },
              context: {
                type: 'string',
                description: 'One short line of context shown under the question. Optional.',
              },
              options: {
                type: 'array',
                description: 'Suggested answers. Mark your own pick with recommended: true.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short answer text.' },
                    description: {
                      type: 'string',
                      description: 'One line explaining the trade-off. Optional.',
                    },
                    recommended: {
                      type: 'boolean',
                      description: 'True for the option you recommend.',
                    },
                  },
                  required: ['label'],
                },
              },
              multiple: {
                type: 'boolean',
                description: 'Allow selecting more than one option.',
              },
              allow_free_text: {
                type: 'boolean',
                description: 'Allow a typed answer in addition to the options. Default true.',
              },
            },
            required: ['question'],
          },
          minItems: 1,
        },
      },
      required: ['questions'],
    },
  },
};

export interface NormalizedAsk {
  questions: AskQuestion[];
}

/**
 * Validate and normalize raw tool arguments.
 * Throws on anything the UI cannot render, so the model gets a clear error
 * instead of a silently dropped question.
 */
export function normalizeAskRequest(args: any): NormalizedAsk {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('ask_user expects an object with a "questions" array.');
  }

  // Accept a single question object as a convenience.
  const raw = Array.isArray(args.questions)
    ? args.questions
    : args.question
      ? [{ question: args.question, options: args.options }]
      : null;

  if (!raw || raw.length === 0) {
    throw new Error('ask_user needs at least one question.');
  }
  if (raw.length > 20) {
    throw new Error(`ask_user accepts at most 20 questions; got ${raw.length}.`);
  }

  const questions: AskQuestion[] = raw.map((entry: any, index: number) => {
    // A bare string is a valid question with no options.
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (!text) throw new Error(`Question ${index + 1} is empty.`);
      return { id: `q${index + 1}`, question: text, options: [], allow_free_text: true };
    }
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Question ${index + 1} must be an object or a string.`);
    }
    const text = typeof entry.question === 'string' ? entry.question.trim() : '';
    if (!text) {
      throw new Error(`Question ${index + 1} is missing "question".`);
    }

    const options: AskOption[] = Array.isArray(entry.options)
      ? entry.options
          .map((option: any) => {
            if (typeof option === 'string') return { label: option.trim() };
            if (!option || typeof option !== 'object') return null;
            const label = typeof option.label === 'string' ? option.label.trim() : '';
            if (!label) return null;
            return {
              label,
              description:
                typeof option.description === 'string' ? option.description.trim() : undefined,
              recommended: option.recommended === true,
            } as AskOption;
          })
          .filter((option: AskOption | null): option is AskOption => option !== null)
          // Recommendations first: they are the answer most users want.
          .sort((a: AskOption, b: AskOption) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
      : [];

    return {
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `q${index + 1}`,
      question: text,
      context: typeof entry.context === 'string' && entry.context.trim() ? entry.context.trim() : undefined,
      options,
      multiple: entry.multiple === true,
      allow_free_text: entry.allow_free_text !== false,
    };
  });

  return { questions };
}

/** Render the collected answers back to the model as plain text. */
export function formatAskAnswers(answers: AskResponse): string {
  if (answers.length === 0) return 'The user did not answer.';
  if (answers.length === 1) {
    const only = answers[0];
    return only.answer.trim() ? only.answer.trim() : 'The user did not answer.';
  }
  return answers
    .map((answer, index) => `${index + 1}. ${answer.question}\n   → ${answer.answer || '(no answer)'}`)
    .join('\n');
}

/**
 * Ask the user and wait. Falls through with a clear message when no UI has
 * registered a handler (headless runs, tests), so the agent is never stuck.
 */
export async function askUser(request: NormalizedAsk, sessionId?: string): Promise<string> {
  if (!askHandler) {
    return 'Error: ask_user is unavailable because no interactive UI is attached. Continue with your best judgement.';
  }
  const answers = await askHandler({ questions: request.questions, sessionId });
  return formatAskAnswers(answers);
}

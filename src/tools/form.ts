/**
 * form tool — collect several labelled answers in one UI interaction.
 *
 * Mirrors the `ask_user` bridge: the CLI registers a handler and this module
 * stays UI-agnostic. Unlike `ask_user`, a form is strictly validated and
 * fail-closed — with no UI attached (headless runs, tests) nothing is ever
 * auto-accepted, and invalid input produces a readable error instead of a
 * thrown exception that would strand the model.
 *
 * The result is deliberately dual-format: short `id: value` lines for a human
 * reader, plus a fenced JSON block the model can parse deterministically.
 */

/** The three answer widgets the UI knows how to render. */
export type FormQuestionType = 'text' | 'select' | 'confirm';

export interface FormQuestion {
  /** Short, stable, unique key. Never a prototype-pollution name. */
  id: string;
  /** Question text rendered to the user (at most 200 chars, control chars removed). */
  label: string;
  type: FormQuestionType;
  /** Choices for a `select` question (1..12). Optional for other types. */
  options?: string[];
  /** Preselected value; must agree with `type`. */
  default?: string | boolean;
  /** Whether the UI should insist on an answer. */
  required?: boolean;
}

export interface FormRequest {
  title?: string;
  questions: FormQuestion[];
  sessionId?: string;
}

export interface FormAnswer {
  id: string;
  value: string | boolean;
}

export type FormResponse = FormAnswer[];

/** Structural twin of `ToolCallContext`; declared here to avoid a circular import. */
export interface FormToolContext {
  sessionId?: string;
  abortSignal?: AbortSignal;
}

/** Handler registered by the UI. Resolves with the collected answers. */
export type FormHandler = (request: FormRequest, signal?: AbortSignal) => Promise<FormResponse>;

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const MAX_LABEL_CHARS = 200;
const MAX_TITLE_CHARS = 200;

/** Upper bound on the serialized question payload, in UTF-8 bytes. */
export const MAX_SERIALIZED_INPUT_BYTES = 32 * 1024;

const CANCELLED = 'Cancelled: form was cancelled; no answers were collected.';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let formHandler: FormHandler | null = null;

export function setFormHandler(handler: FormHandler): void {
  formHandler = handler;
}

export function clearFormHandler(): void {
  formHandler = null;
}

export function hasFormHandler(): boolean {
  return formHandler !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remove C0/C1 control characters so labels cannot inject newlines or escapes. */
function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

function isUnsafeKey(value: string): boolean {
  return UNSAFE_KEYS.has(value);
}

function isFormQuestionType(value: unknown): value is FormQuestionType {
  return value === 'text' || value === 'select' || value === 'confirm';
}

export const formTool = {
  type: 'function' as const,
  function: {
    name: 'form',
    description:
      'Ask the user several labelled questions at once and wait for all answers. Use this when a decision needs multiple related inputs (a name and a choice, a few confirmations, etc.). Each question needs a unique id, a short label, and a type: text for free-form input, select for a choice from options, confirm for yes/no. Supply a default when there is an obvious answer and mark required questions explicitly. Returns the answers keyed by id.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional heading shown above the form.',
        },
        questions: {
          type: 'array',
          description: `Between 1 and ${MAX_QUESTIONS} labelled questions to answer together.`,
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable unique id, e.g. "approach".' },
              label: { type: 'string', description: `Question text shown to the user (max ${MAX_LABEL_CHARS} chars).` },
              type: {
                type: 'string',
                enum: ['text', 'select', 'confirm'],
                description: 'text = typed answer, select = pick one option, confirm = yes/no.',
              },
              options: {
                type: 'array',
                description: `1..${MAX_OPTIONS} choices. Required for select questions, ignored otherwise.`,
                items: { type: 'string' },
                minItems: 1,
                maxItems: MAX_OPTIONS,
              },
              default: {
                anyOf: [{ type: 'string' }, { type: 'boolean' }],
                description: 'Preselected answer. String for text/select, boolean for confirm.',
              },
              required: { type: 'boolean', description: 'Ask the UI to insist on an answer.' },
            },
            required: ['id', 'label', 'type'],
          },
        },
      },
      required: ['questions'],
    },
  },
};

export type FormValidation =
  | { ok: true; request: FormRequest }
  | { ok: false; error: string };

/**
 * Validate and normalize raw tool arguments.
 * Never throws — every problem is returned as a readable error string so the
 * handler can hand it straight back to the model.
 */
export function validateFormRequest(args: unknown): FormValidation {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Error: form expects an object with a "questions" array.' };
  }
  const raw = args as Record<string, unknown>;
  const rawQuestions = raw.questions;
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: 'Error: form requires a "questions" array.' };
  }
  if (rawQuestions.length < 1) {
    return { ok: false, error: 'Error: form needs at least one question.' };
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    return { ok: false, error: `Error: form accepts at most ${MAX_QUESTIONS} questions; got ${rawQuestions.length}.` };
  }

  let title: string | undefined;
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string') {
      return { ok: false, error: 'Error: form "title" must be a string.' };
    }
    title = sanitize(raw.title).trim();
    if (title.length > MAX_TITLE_CHARS) {
      return { ok: false, error: `Error: form title exceeds ${MAX_TITLE_CHARS} characters.` };
    }
    if (!title) title = undefined;
  }

  const questions: FormQuestion[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawQuestions.length; i++) {
    const where = `Question ${i + 1}`;
    const entry = rawQuestions[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `Error: ${where} must be an object.` };
    }
    const q = entry as Record<string, unknown>;

    if (typeof q.id !== 'string') {
      return { ok: false, error: `Error: ${where} is missing a string "id".` };
    }
    const id = sanitize(q.id).trim();
    if (!id) {
      return { ok: false, error: `Error: ${where} has an empty "id".` };
    }
    if (isUnsafeKey(id)) {
      return { ok: false, error: `Error: ${where} uses the reserved id "${id}".` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `Error: duplicate question id "${id}".` };
    }
    seenIds.add(id);

    if (typeof q.label !== 'string') {
      return { ok: false, error: `Error: ${where} is missing a string "label".` };
    }
    const label = sanitize(q.label).trim();
    if (!label) {
      return { ok: false, error: `Error: ${where} has an empty "label".` };
    }
    if (label.length > MAX_LABEL_CHARS) {
      return { ok: false, error: `Error: ${where} label exceeds ${MAX_LABEL_CHARS} characters.` };
    }

    if (!isFormQuestionType(q.type)) {
      return { ok: false, error: `Error: ${where} has invalid "type"; expected text, select or confirm.` };
    }
    const type = q.type;

    let options: string[] | undefined;
    if (q.options !== undefined && q.options !== null) {
      if (!Array.isArray(q.options)) {
        return { ok: false, error: `Error: ${where} "options" must be an array of strings.` };
      }
      if (q.options.length < 1 || q.options.length > MAX_OPTIONS) {
        return { ok: false, error: `Error: ${where} must have between 1 and ${MAX_OPTIONS} options.` };
      }
      options = [];
      const seenOptions = new Set<string>();
      for (const option of q.options) {
        if (typeof option !== 'string') {
          return { ok: false, error: `Error: ${where} options must all be strings.` };
        }
        const clean = sanitize(option).trim();
        if (!clean) {
          return { ok: false, error: `Error: ${where} has an empty option.` };
        }
        if (isUnsafeKey(clean)) {
          return { ok: false, error: `Error: ${where} uses the reserved option "${clean}".` };
        }
        if (seenOptions.has(clean)) {
          return { ok: false, error: `Error: ${where} has a duplicate option "${clean}".` };
        }
        seenOptions.add(clean);
        options.push(clean);
      }
    }
    if (type === 'select' && (!options || options.length === 0)) {
      return { ok: false, error: `Error: ${where} of type "select" requires 1..${MAX_OPTIONS} options.` };
    }

    let defaultValue: string | boolean | undefined;
    if (q.default !== undefined && q.default !== null) {
      if (type === 'confirm') {
        if (typeof q.default !== 'boolean') {
          return { ok: false, error: `Error: ${where} default must be a boolean for confirm questions.` };
        }
        defaultValue = q.default;
      } else {
        if (typeof q.default !== 'string') {
          return { ok: false, error: `Error: ${where} default must be a string for ${type} questions.` };
        }
        const clean = sanitize(q.default).trim();
        if (type === 'select' && options && !options.includes(clean)) {
          return { ok: false, error: `Error: ${where} default "${clean}" is not one of its options.` };
        }
        defaultValue = clean;
      }
    }

    let required: boolean | undefined;
    if (q.required !== undefined && q.required !== null) {
      if (typeof q.required !== 'boolean') {
        return { ok: false, error: `Error: ${where} "required" must be a boolean.` };
      }
      required = q.required;
    }

    questions.push({
      id,
      label,
      type,
      ...(options ? { options } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(required !== undefined ? { required } : {}),
    });
  }

  const request: FormRequest = { questions, ...(title ? { title } : {}) };
  try {
    const bytes = Buffer.byteLength(JSON.stringify({ title: title ?? null, questions }), 'utf8');
    if (bytes > MAX_SERIALIZED_INPUT_BYTES) {
      return {
        ok: false,
        error: `Error: form input is too large (${bytes} bytes); the limit is ${MAX_SERIALIZED_INPUT_BYTES} bytes.`,
      };
    }
  } catch (err) {
    return { ok: false, error: `Error: form input could not be serialized: ${errorMessage(err)}` };
  }
  return { ok: true, request };
}

/** Render answers as `id: value` lines plus a machine-readable JSON block. */
export function formatFormResult(request: FormRequest, response: FormResponse): string {
  const record: Record<string, string | boolean | null> = Object.create(null);
  const values = new Map<string, unknown>();

  if (Array.isArray(response)) {
    for (const answer of response) {
      if (!answer || typeof answer !== 'object') continue;
      const id = typeof answer.id === 'string' ? sanitize(answer.id).trim() : '';
      if (!id || isUnsafeKey(id) || values.has(id)) continue;
      values.set(id, (answer as { value?: unknown }).value);
    }
  }

  const lines: string[] = [];
  for (const question of request.questions) {
    const raw = values.get(question.id);
    const fallback = question.default;
    let value: string | boolean | null;
    if (question.type === 'confirm') {
      if (typeof raw === 'boolean') {
        value = raw;
      } else if (typeof raw === 'string' && /^(true|false)$/i.test(raw.trim())) {
        value = raw.trim().toLowerCase() === 'true';
      } else if (typeof fallback === 'boolean') {
        value = fallback;
      } else {
        value = null;
      }
    } else if (typeof raw === 'string') {
      value = sanitize(raw);
    } else if (typeof raw === 'boolean') {
      value = String(raw);
    } else if (typeof fallback === 'string') {
      value = sanitize(fallback);
    } else {
      value = null;
    }
    record[question.id] = value;
    lines.push(`${question.id}: ${value === null ? '(no answer)' : String(value)}`);
  }

  const heading = request.title ? `${request.title}\n` : '';
  return `${heading}${lines.join('\n')}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

/**
 * Validate, delegate to the registered UI, and format the result.
 * Fail-closed: no UI means no answers, and no exception ever escapes.
 */
export async function form(args: unknown = {}, context: FormToolContext = {}): Promise<string> {
  try {
    if (context?.abortSignal?.aborted) return CANCELLED;

    const validation = validateFormRequest(args);
    if (!validation.ok) return validation.error;
    const { request } = validation;

    if (!formHandler) {
      return 'Error: form is unavailable because no interactive UI that supports forms is attached. No answers were collected; continue with your best judgement.';
    }

    const uiRequest: FormRequest = {
      ...request,
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    };

    let response: FormResponse;
    try {
      response = await formHandler(uiRequest, context?.abortSignal);
    } catch (err) {
      if (context?.abortSignal?.aborted) return CANCELLED;
      return `Error: the form UI failed: ${errorMessage(err)}`;
    }
    if (context?.abortSignal?.aborted) return CANCELLED;

    return formatFormResult(request, response);
  } catch (err) {
    return `Error in form: ${errorMessage(err)}`;
  }
}

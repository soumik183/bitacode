import test from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import {
  clearFormHandler,
  form,
  formTool,
  formatFormResult,
  hasFormHandler,
  MAX_SERIALIZED_INPUT_BYTES,
  setFormHandler,
  validateFormRequest,
  type FormAnswer,
  type FormRequest,
} from '../src/tools/form.js';

afterEach(() => {
  clearFormHandler();
});

function validArgs() {
  return {
    title: 'Setup',
    questions: [
      { id: 'name', label: 'Your name', type: 'text', default: 'Ada' },
      { id: 'color', label: 'Pick a colour', type: 'select', options: ['red', 'blue'], default: 'blue' },
      { id: 'ok', label: 'Proceed?', type: 'confirm', default: true },
    ],
  };
}

function fencedJson(result: string): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(result);
  assert.ok(match, 'result must contain a fenced json block');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test('form tool is registered with a usable schema', () => {
  assert.equal(formTool.type, 'function');
  assert.equal(formTool.function.name, 'form');
  assert.match(formTool.function.description, /several|multiple/i);
  const params = formTool.function.parameters as any;
  assert.deepEqual(params.required, ['questions']);
  assert.equal(params.properties.questions.type, 'array');
  assert.equal(params.properties.questions.minItems, 1);
  assert.equal(params.properties.questions.maxItems, 8);
  const item = params.properties.questions.items;
  assert.deepEqual(item.required, ['id', 'label', 'type']);
  assert.deepEqual(item.properties.type.enum, ['text', 'select', 'confirm']);
  assert.equal(item.properties.options.maxItems, 12);
});

test('valid input normalizes with sanitized strings', () => {
  const result = validateFormRequest(validArgs());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.title, 'Setup');
  assert.equal(result.request.questions.length, 3);
  assert.deepEqual(result.request.questions[1].options, ['red', 'blue']);
  assert.equal(result.request.questions[2].default, true);
});

test('non-object input and missing questions are rejected as strings', () => {
  for (const bad of [null, undefined, 'form', [], 42]) {
    const result = validateFormRequest(bad);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /expects an object|questions/);
  }
  const missing = validateFormRequest({ title: 'x' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /"questions" array/);
});

test('question count is limited to 1..8', () => {
  const empty = validateFormRequest({ questions: [] });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /at least one/);

  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, label: `Q${i}`, type: 'text' }));
  assert.equal(validateFormRequest({ questions: eight }).ok, true);

  const nine = [...eight, { id: 'q8', label: 'Q8', type: 'text' }];
  const tooMany = validateFormRequest({ questions: nine });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.error, /at most 8/);
});

test('ids must be present, non-empty and unique', () => {
  const missing = validateFormRequest({ questions: [{ label: 'x', type: 'text' }] });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /"id"/);

  const empty = validateFormRequest({ questions: [{ id: '  ', label: 'x', type: 'text' }] });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /empty "id"/);

  const dup = validateFormRequest({
    questions: [
      { id: 'same', label: 'a', type: 'text' },
      { id: 'same', label: 'b', type: 'text' },
    ],
  });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /duplicate question id/);
});

test('prototype-pollution names are rejected in ids and options', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const byId = validateFormRequest({ questions: [{ id: key, label: 'x', type: 'text' }] });
    assert.equal(byId.ok, false, `id ${key} must be rejected`);
    if (!byId.ok) assert.match(byId.error, /reserved id/);

    const byOption = validateFormRequest({
      questions: [{ id: 'x', label: 'x', type: 'select', options: [key] }],
    });
    assert.equal(byOption.ok, false, `option ${key} must be rejected`);
  }
});

test('labels are required and capped at 200 characters', () => {
  const missing = validateFormRequest({ questions: [{ id: 'x', type: 'text' }] });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /"label"/);

  const long = validateFormRequest({ questions: [{ id: 'x', label: 'a'.repeat(201), type: 'text' }] });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /exceeds 200/);

  assert.equal(validateFormRequest({ questions: [{ id: 'x', label: 'a'.repeat(200), type: 'text' }] }).ok, true);
});

test('type and required are validated', () => {
  const badType = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'multi' }] });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.match(badType.error, /invalid "type"/);

  const badRequired = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'text', required: 'yes' }] });
  assert.equal(badRequired.ok, false);
  if (!badRequired.ok) assert.match(badRequired.error, /"required" must be a boolean/);
});

test('select options must be 1..12 non-empty unique strings', () => {
  const absent = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'select' }] });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.match(absent.error, /requires 1\.\.12 options/);

  const emptyOptions = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'select', options: [] }] });
  assert.equal(emptyOptions.ok, false);

  const thirteen = Array.from({ length: 13 }, (_, i) => `o${i}`);
  const tooMany = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'select', options: thirteen }] });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.error, /between 1 and 12/);

  const dup = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'select', options: ['a', 'a'] }] });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.error, /duplicate option/);

  assert.equal(validateFormRequest({
    questions: [{ id: 'x', label: 'x', type: 'select', options: Array.from({ length: 12 }, (_, i) => `o${i}`) }],
  }).ok, true);
});

test('defaults must be compatible with the question type', () => {
  const badConfirm = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'confirm', default: 'true' }] });
  assert.equal(badConfirm.ok, false);
  if (!badConfirm.ok) assert.match(badConfirm.error, /boolean for confirm/);

  const badText = validateFormRequest({ questions: [{ id: 'x', label: 'x', type: 'text', default: 7 }] });
  assert.equal(badText.ok, false);
  if (!badText.ok) assert.match(badText.error, /string for text/);

  const notAnOption = validateFormRequest({
    questions: [{ id: 'x', label: 'x', type: 'select', options: ['a'], default: 'b' }],
  });
  assert.equal(notAnOption.ok, false);
  if (!notAnOption.ok) assert.match(notAnOption.error, /not one of its options/);

  assert.equal(validateFormRequest({
    questions: [{ id: 'x', label: 'x', type: 'select', options: ['a'], default: 'a' }],
  }).ok, true);
});

test('serialized input is capped at 32 KB', () => {
  const huge = validateFormRequest({
    questions: [{ id: 'x', label: 'x', type: 'select', options: ['a'.repeat(MAX_SERIALIZED_INPUT_BYTES)] }],
  });
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.match(huge.error, /too large/);
});

test('form fails closed when no UI handler is registered', async () => {
  clearFormHandler();
  assert.equal(hasFormHandler(), false);
  const result = await form(validArgs());
  assert.match(result, /no interactive UI/);
  assert.doesNotMatch(result, /```/);
});

test('form delegates to the handler and returns both summary and JSON', async () => {
  let seenRequest: FormRequest | undefined;
  setFormHandler(async (request) => {
    seenRequest = request;
    return [
      { id: 'name', value: 'Grace' },
      { id: 'color', value: 'red' },
      { id: 'ok', value: true },
    ] satisfies FormAnswer[];
  });
  assert.equal(hasFormHandler(), true);

  const result = await form(validArgs(), { sessionId: 's1' });
  assert.match(result, /Setup\n/);
  assert.match(result, /name: Grace/);
  assert.match(result, /color: red/);
  assert.match(result, /ok: true/);
  assert.deepEqual(fencedJson(result), { name: 'Grace', color: 'red', ok: true });
  assert.equal(seenRequest?.sessionId, 's1');
  assert.equal(seenRequest?.questions.length, 3);
});

test('missing answers fall back to defaults and confirm strings coerce', () => {
  const request = validateFormRequest(validArgs());
  assert.equal(request.ok, true);
  if (!request.ok) return;
  const rendered = formatFormResult(request.request, [{ id: 'ok', value: 'false' }]);
  assert.match(rendered, /name: Ada/);
  assert.match(rendered, /color: blue/);
  assert.match(rendered, /ok: false/);
  assert.deepEqual(fencedJson(rendered), { name: 'Ada', color: 'blue', ok: false });
});

test('unanswered questions render as (no answer) and null', () => {
  const rendered = formatFormResult(
    { questions: [{ id: 'free', label: 'Free', type: 'text' }] },
    []
  );
  assert.match(rendered, /free: \(no answer\)/);
  assert.deepEqual(fencedJson(rendered), { free: null });
});

test('a rejected handler becomes a readable tool result', async () => {
  setFormHandler(async () => {
    throw new Error('ui exploded');
  });
  const result = await form(validArgs());
  assert.match(result, /^Error:/);
  assert.match(result, /ui exploded/);
  assert.doesNotMatch(result, /```/);
});

test('a synchronously throwing handler is also contained', async () => {
  setFormHandler((() => {
    throw new Error('sync boom');
  }) as any);
  const result = await form(validArgs());
  assert.match(result, /Error: the form UI failed: sync boom/);
});

test('an already-aborted signal cancels without calling the UI', async () => {
  let called = false;
  setFormHandler(async () => {
    called = true;
    return [];
  });
  const controller = new AbortController();
  controller.abort();
  const result = await form(validArgs(), { abortSignal: controller.signal });
  assert.match(result, /^Cancelled:/);
  assert.equal(called, false);
});

test('aborting while the UI is pending cancels the result', async () => {
  const controller = new AbortController();
  setFormHandler(async (_request, signal) => {
    controller.abort();
    assert.equal(signal?.aborted, true);
    await Promise.resolve();
    return [{ id: 'name', value: 'late' }];
  });
  const result = await form(validArgs(), { abortSignal: controller.signal });
  assert.match(result, /^Cancelled:/);
  assert.doesNotMatch(result, /```/);
});

test('control characters are stripped from labels, options and answers', async () => {
  const args = {
    questions: [
      { id: 'name', label: 'Your\u0001name\nplease', type: 'text' },
      { id: 'c', label: 'Colour', type: 'select', options: ['re\td', 'blue'] },
    ],
  };
  const validated = validateFormRequest(args);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.request.questions[0].label, 'Yournameplease');
    assert.deepEqual(validated.request.questions[1].options, ['red', 'blue']);
  }

  setFormHandler(async () => [{ id: 'name', value: 'Ada\nLovelace\u0007' }]);
  const result = await form(args);
  assert.match(result, /name: AdaLovelace/);
  // Newlines (0x0A) separate the lines themselves; every other control char is gone.
  assert.ok(!/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(result));
  assert.deepEqual(fencedJson(result), { name: 'AdaLovelace', c: null });
});

test('form returns validation errors as strings rather than throwing', async () => {
  const result = await form({ questions: [{ id: '__proto__', label: 'x', type: 'text' }] });
  assert.match(result, /^Error:/);
  assert.match(result, /reserved id/);
});

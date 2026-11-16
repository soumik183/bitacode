import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askQuestionTool,
  clearAskHandler,
  formatAskAnswers,
  hasAskHandler,
  normalizeAskRequest,
  setAskHandler,
  askUser,
} from '../src/tools/ask.js';

test('ask tool is registered with a usable schema', () => {
  assert.equal(askQuestionTool.function.name, 'ask_user');
  assert.match(askQuestionTool.function.description, /question/i);
  const params = askQuestionTool.function.parameters as any;
  assert.deepEqual(params.required, ['questions']);
  assert.equal(params.properties.questions.type, 'array');
});

test('a single question normalizes without an id', () => {
  const { questions } = normalizeAskRequest({ questions: [{ question: 'Which approach?' }] });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, 'Which approach?');
  assert.equal(questions[0].id, 'q1');
  assert.deepEqual(questions[0].options, []);
});

test('bare questions and single-question shorthand are accepted', () => {
  // A plain string list.
  const fromStrings = normalizeAskRequest({ questions: ['First?', 'Second?'] });
  assert.equal(fromStrings.questions.length, 2);
  assert.equal(fromStrings.questions[1].question, 'Second?');

  // The older { question, options } shape.
  const shorthand = normalizeAskRequest({ question: 'Pick one', options: ['a', 'b'] });
  assert.equal(shorthand.questions.length, 1);
  assert.deepEqual(shorthand.questions[0].options.map((option) => option.label), ['a', 'b']);
});

test('the recommended option is sorted first and marked', () => {
  const { questions } = normalizeAskRequest({
    questions: [
      {
        question: 'Which library?',
        options: [
          { label: 'vitest' },
          { label: 'node:test', recommended: true },
          { label: 'jest' },
        ],
      },
    ],
  });
  const options = questions[0].options!;
  assert.equal(options[0].label, 'node:test');
  assert.equal(options[0].recommended, true);
  // The relative order of the rest is preserved.
  assert.deepEqual(options.map((option) => option.label), ['node:test', 'vitest', 'jest']);
});

test('multiple and allow_free_text default sensibly', () => {
  const { questions } = normalizeAskRequest({
    questions: [
      { question: 'One or many?', multiple: true },
      { question: 'Typed only?', allow_free_text: false },
    ],
  });
  assert.equal(questions[0].multiple, true);
  assert.equal(questions[1].allow_free_text, false);
  // Default: typing stays available.
  assert.equal(questions[0].allow_free_text, true);
});

test('malformed asks are rejected with a clear message', () => {
  assert.throws(() => normalizeAskRequest(null), /questions/);
  assert.throws(() => normalizeAskRequest({}), /at least one question/);
  assert.throws(() => normalizeAskRequest({ questions: [] }), /at least one question/);
  assert.throws(() => normalizeAskRequest({ questions: [{ question: '  ' }] }), /missing "question"/);
  assert.throws(
    () => normalizeAskRequest({ questions: Array.from({ length: 21 }, (_, i) => ({ question: `q${i}` })) }),
    /at most 20/
  );
});

test('invalid options are dropped instead of crashing the prompt', () => {
  const { questions } = normalizeAskRequest({
    questions: [{ question: 'Pick', options: [null, {}, { label: '  ' }, { label: 'ok' }] }],
  });
  assert.deepEqual(questions[0].options!.map((option) => option.label), ['ok']);
});

test('answers are formatted for the model', () => {
  assert.equal(formatAskAnswers([{ id: 'q1', question: 'Which?', answer: 'vitest' }]), 'vitest');
  assert.equal(formatAskAnswers([{ id: 'q1', question: 'Which?', answer: '' }]), 'The user did not answer.');
  assert.equal(formatAskAnswers([]), 'The user did not answer.');

  const multi = formatAskAnswers([
    { id: 'a', question: 'First?', answer: 'one' },
    { id: 'b', question: 'Second?', answer: '' },
  ]);
  assert.match(multi, /1\. First\?\n {3}→ one/);
  assert.match(multi, /2\. Second\?\n {3}→ \(no answer\)/);
});

test('askUser fails closed when no UI is attached', async () => {
  clearAskHandler();
  assert.equal(hasAskHandler(), false);
  const result = await askUser({ questions: [{ question: 'Hi?', id: 'q1' }] });
  assert.match(result, /no interactive UI/);
});

test('askUser returns the handler answers', async () => {
  setAskHandler(async (request) => {
    assert.equal(request.questions.length, 1);
    return [{ id: 'q1', question: request.questions[0].question, answer: 'the second one' }];
  });
  assert.equal(hasAskHandler(), true);
  try {
    const result = await askUser({ questions: [{ question: 'Which?', id: 'q1' }] });
    assert.equal(result, 'the second one');
  } finally {
    clearAskHandler();
  }
});
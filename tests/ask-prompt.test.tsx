import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { AskPrompt } from '../src/components/AskPrompt.js';
import type { AskQuestion, AskResponse } from '../src/tools/ask.js';

const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('ask prompt renders the question, options and recommendation', async () => {
  const questions: AskQuestion[] = [
    {
      id: 'approach',
      question: 'Which approach should I take?',
      context: 'Both work; one is simpler.',
      options: [
        { label: 'Rewrite', recommended: true },
        { label: 'Patch' },
      ],
    },
  ];
  const { lastFrame } = render(<AskPrompt questions={questions} columns={80} onRespond={() => {}} />);
  await wait();
  const frame = lastFrame() ?? '';
  assert.match(frame, /Agent question/);
  assert.match(frame, /Which approach should I take\?/);
  assert.match(frame, /Both work/);
  assert.match(frame, /1\. Rewrite/);
  assert.match(frame, /recommended/);
  assert.match(frame, /2\. Patch/);
  assert.match(frame, /1\/1|enter send/);
});

test('pressing a number picks that option and answers', async () => {
  const questions: AskQuestion[] = [
    { id: 'q', question: 'Pick one', options: [{ label: 'alpha' }, { label: 'beta' }] },
  ];
  let response: AskResponse | null = null;
  const { stdin } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  stdin.write('2');
  await wait();
  assert.deepEqual(response, [{ id: 'q', question: 'Pick one', answer: 'beta' }]);
});

test('enter sends the highlighted option', async () => {
  const questions: AskQuestion[] = [
    { id: 'q', question: 'Pick one', options: [{ label: 'alpha', recommended: true }, { label: 'beta' }] },
  ];
  let response: AskResponse | null = null;
  const { stdin } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  // Down then Enter selects the second option.
  stdin.write('\u001B[B');
  await wait();
  stdin.write('\r');
  await wait();
  assert.equal(response?.[0].answer, 'beta');
});

test('free text only question accepts typing then enter', async () => {
  const questions: AskQuestion[] = [{ id: 'q', question: 'What name?' }];
  let response: AskResponse | null = null;
  const { stdin, lastFrame } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  stdin.write('my-project');
  await wait();
  assert.match(lastFrame() ?? '', /my-project/);
  stdin.write('\r');
  await wait();
  assert.equal(response?.[0].answer, 'my-project');
});

test('multi question asks advance one at a time and answer as a group', async () => {
  const questions: AskQuestion[] = [
    { id: 'a', question: 'First question?' },
    { id: 'b', question: 'Second question?' },
  ];
  let response: AskResponse | null = null;
  const { stdin, lastFrame } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  assert.match(lastFrame() ?? '', /1\/2/);
  stdin.write('one');
  await wait();
  stdin.write('\r');
  await wait();
  assert.match(lastFrame() ?? '', /2\/2/);
  stdin.write('two');
  await wait();
  stdin.write('\r');
  await wait();
  assert.deepEqual(response, [
    { id: 'a', question: 'First question?', answer: 'one' },
    { id: 'b', question: 'Second question?', answer: 'two' },
  ]);
});

test('escape skips the question instead of trapping the user', async () => {
  const questions: AskQuestion[] = [{ id: 'q', question: 'Are you sure?' }];
  let response: AskResponse | null = null;
  const { stdin } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  stdin.write('\u001B');
  await wait();
  assert.deepEqual(response, [{ id: 'q', question: 'Are you sure?', answer: '' }]);
});

test('multi-select toggles several options', async () => {
  const questions: AskQuestion[] = [
    { id: 'q', question: 'Pick some', multiple: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
  ];
  let response: AskResponse | null = null;
  const { stdin } = render(
    <AskPrompt questions={questions} columns={80} onRespond={(result) => { response = result; }} />
  );
  await wait();
  stdin.write('1'); // toggle a
  await wait();
  stdin.write('3'); // toggle c
  await wait();
  stdin.write('\r'); // confirm
  await wait();
  assert.equal(response?.[0].answer, 'a, c');
});

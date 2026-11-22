import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { PromptInput } from '../src/components/PromptInput.js';
import { settle } from './helpers/wait.js';

function harness(initial = '') {
  let value = initial;
  let submitted: string | null = null;
  const Harness: React.FC<{
    value?: string;
    caretRequest?: { col: number; nonce: number };
  }> = ({ value: next, caretRequest }) => {
    const [state, setState] = React.useState(next ?? initial);
    React.useEffect(() => {
      if (next !== undefined && next !== state) setState(next);
    }, [next]);
    value = state;
    return (
      <PromptInput
        value={state}
        onChange={setState}
        onSubmit={(text) => { submitted = text; }}
        caretRequest={caretRequest}
      />
    );
  };
  return {
    Harness,
    value: () => value,
    submitted: () => submitted,
  };
}

test('ctrl+left/right moves the caret by whole words', async () => {
  const h = harness('alpha beta gamma');
  const view = render(<h.Harness />);
  await settle(40);
  view.stdin.write('\x1b[1;5D'); // ctrl+left -> before "gamma"
  await settle(40);
  view.stdin.write('X');
  await settle(40);
  assert.equal(h.value(), 'alpha beta Xgamma');
  view.unmount();
});

test('a new line keeps the current indentation', async () => {
  const h = harness('  item');
  const view = render(<h.Harness />);
  await settle(40);
  view.stdin.write('\x1b[13;2u'); // shift+enter
  await settle(40);
  view.stdin.write('next');
  await settle(40);
  assert.equal(h.value(), '  item\n  next');
  view.unmount();
});

test('enter submits the freshest text even when typed in the same frame', async () => {
  const h = harness();
  const view = render(<h.Harness />);
  await settle(40);
  // No settle between the keystrokes: the value ref must be authoritative.
  view.stdin.write('fast');
  view.stdin.write('\r');
  await settle(60);
  assert.equal(h.submitted(), 'fast');
  view.unmount();
});

test('a click request positions the caret by column', async () => {
  const h = harness('hello world');
  const view = render(<h.Harness caretRequest={{ col: 6, nonce: 1 }} />);
  await settle(40);
  view.stdin.write('X');
  await settle(40);
  assert.equal(h.value(), 'hello Xworld');
  view.unmount();
});

test('shrinking the value externally never leaves a stale caret', async () => {
  const h = harness('a very long draft');
  const view = render(<h.Harness value="a very long draft" />);
  await settle(40);
  view.stdin.write('\x1b[1;5D'); // move left a word
  await settle(40);
  view.rerender(<h.Harness value="hi" />);
  await settle(40);
  view.stdin.write('!');
  await settle(40);
  assert.ok(h.value().length > 0 && h.value().length <= 4, 'edit lands inside the shorter value');
  view.unmount();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { settle, waitFor } from './helpers/wait.js';
import { PromptInput } from '../src/components/PromptInput.js';

// ctrl+letter arrives as the control byte; Ink turns it into the bare letter.
// alt/meta+letter arrives as ESC + letter; Ink reports it via `key.meta`.
const CTRL = {
  a: '\x01',
  d: '\x04',
  e: '\x05',
  k: '\x0b',
  u: '\x15',
  w: '\x17',
};
const META = {
  a: '\x1ba',
  d: '\x1bd',
  e: '\x1be',
  k: '\x1bk',
  u: '\x1bu',
  w: '\x1bw',
  backspace: '\x1b\b',
  delete: '\x1b\x7f',
};
const LEFT = '\x1b[D';

type Stdin = { write: (data: string) => void };

/** One key per write (Ink only dispatches one keypress per write). */
async function press(
  stdin: Stdin,
  lastFrame: () => string | undefined,
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    const before = lastFrame();
    stdin.write(key);
    // Ink re-renders asynchronously; until the new frame lands, useInput still
    // holds the previous offset and the next key would edit at a stale cursor.
    await waitFor(() => lastFrame() !== before, 100).catch(() => {});
    await settle(15);
  }
  await settle(50);
}

function valueHarness(initial: string) {
  let current = initial;
  const Harness: React.FC = () => {
    const [state, setState] = React.useState(initial);
    current = state;
    return <PromptInput value={state} onChange={setState} onSubmit={() => {}} />;
  };
  return { Harness, value: () => current };
}

test('ctrl+a and meta+a move the cursor to the start of the input', async () => {
  const ctrl = valueHarness('abcdef');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, CTRL.a, 'X');
  assert.equal(ctrl.value(), 'Xabcdef');

  // Wide glyphs: the cursor must land before the first code point, not inside
  // an emoji's surrogate pair.
  const meta = valueHarness('漢😀b');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, META.a, 'X');
  assert.equal(meta.value(), 'X漢😀b');
});

test('ctrl+e and meta+e move the cursor to the end of the input', async () => {
  const ctrl = valueHarness('abcdef');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, CTRL.e, 'X');
  assert.equal(ctrl.value(), 'abcdefX');

  const meta = valueHarness('漢😀b');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, LEFT, LEFT, LEFT, META.e, 'X');
  assert.equal(meta.value(), '漢😀bX');
});

test('ctrl+u and meta+u clear the whole input and reset the cursor', async () => {
  const ctrl = valueHarness('abcdef');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, CTRL.u);
  assert.equal(ctrl.value(), '');
  await press(c.stdin, c.lastFrame, 'Z');
  assert.equal(ctrl.value(), 'Z', 'cursor was reset to 0');

  const meta = valueHarness('漢😀b');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, META.u);
  assert.equal(meta.value(), '');
});

test('ctrl+w and meta+w delete the word before the cursor', async () => {
  const ctrl = valueHarness('hello world');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, CTRL.w);
  assert.equal(ctrl.value(), 'hello ');

  // Stop at start: with the cursor at index 6 the word before it is "hello".
  const start = valueHarness('hello world');
  const s = render(<start.Harness />);
  await settle();
  await press(s.stdin, s.lastFrame, LEFT, LEFT, LEFT, LEFT, LEFT, CTRL.w);
  assert.equal(start.value(), 'world');

  // Wide glyphs: whole code points are removed, never a half surrogate.
  const meta = valueHarness('漢字 😀xy');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, META.w);
  assert.equal(meta.value(), '漢字 ');
});

test('alt/meta+backspace and meta+delete delete the word before the cursor', async () => {
  const backspace = valueHarness('hello world');
  const b = render(<backspace.Harness />);
  await settle();
  await press(b.stdin, b.lastFrame, META.backspace);
  assert.equal(backspace.value(), 'hello ');

  const del = valueHarness('😀abc def');
  const d = render(<del.Harness />);
  await settle();
  await press(d.stdin, d.lastFrame, META.delete);
  assert.equal(del.value(), '😀abc ');
});

test('ctrl+d and meta+d delete the character at the cursor without inserting', async () => {
  const ctrl = valueHarness('abcdef');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, LEFT, LEFT, LEFT, CTRL.d);
  assert.equal(ctrl.value(), 'abcef');

  // Emoji is one code point: delete it whole, not one UTF-16 unit.
  const meta = valueHarness('a😀b');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, LEFT, LEFT, META.d);
  assert.equal(meta.value(), 'ab');
});

test('ctrl+k and meta+k delete from the cursor to the end', async () => {
  const ctrl = valueHarness('abcdef');
  const c = render(<ctrl.Harness />);
  await settle();
  await press(c.stdin, c.lastFrame, LEFT, LEFT, LEFT, CTRL.k);
  assert.equal(ctrl.value(), 'abc');

  const meta = valueHarness('漢😀bcd');
  const m = render(<meta.Harness />);
  await settle();
  await press(m.stdin, m.lastFrame, LEFT, LEFT, LEFT, META.k);
  assert.equal(meta.value(), '漢😀');
});

test('control shortcuts never leak control characters into the value', async () => {
  const { Harness, value } = valueHarness('ab cd');
  const { stdin } = render(<Harness />);
  await settle();
  for (const key of [
    CTRL.a, CTRL.e, CTRL.u, CTRL.w, CTRL.d, CTRL.k,
    META.a, META.e, META.u, META.w, META.d, META.k,
    META.backspace, META.delete,
  ]) {
    stdin.write(key);
    await settle(15);
  }
  await settle(50);
  assert.ok(
    Array.from(value()).every((ch) => ch.charCodeAt(0) >= 32),
    `control chars leaked: ${JSON.stringify(value())}`
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installTerminalRestore, terminalRestoreSequence } from '../src/utils/stable-render.js';

function harness() {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const stdout = {
    write: (chunk: string) => { writes.push(String(chunk)); return true; },
  } as any;
  const dispose = installTerminalRestore(stdout, emitter as any);
  return { emitter, writes, stdout, dispose };
}

test('restore sequence leaves alt screen, resets OSC/mouse and shows cursor', () => {
  assert.equal(
    terminalRestoreSequence(),
    '\x1b[?1006l\x1b[?1000l\x1b]111\x07\x1b[?1049l\x1b[?25h'
  );
});

test('a signal writes the exact restore sequence once', (t) => {
  const h = harness();
  t.after(h.dispose);
  h.emitter.emit('SIGTERM');
  assert.deepEqual(h.writes, [terminalRestoreSequence()]);
  h.emitter.emit('SIGTERM');
  h.emitter.emit('exit');
  h.emitter.emit('SIGHUP');
  assert.equal(h.writes.length, 1, 'further events do not rewrite');
});

test('normal exit also restores', (t) => {
  const h = harness();
  t.after(h.dispose);
  h.emitter.emit('exit');
  assert.deepEqual(h.writes, [terminalRestoreSequence()]);
});

test('installing restore handlers twice is idempotent', (t) => {
  const h = harness();
  t.after(h.dispose);
  const again = installTerminalRestore(h.stdout, h.emitter as any);
  assert.equal(again, h.dispose, 'a second install returns the existing disposer');
  h.emitter.emit('SIGHUP');
  assert.equal(h.writes.length, 1, 'only one handler is registered');
});

test('dispose removes handlers and allows a fresh install', (t) => {
  const h = harness();
  h.dispose();
  h.emitter.emit('SIGINT');
  assert.equal(h.writes.length, 0, 'no handler after dispose');

  const next = harness();
  t.after(next.dispose);
  next.emitter.emit('SIGTERM');
  assert.equal(next.writes.length, 1, 'reinstall works');
});

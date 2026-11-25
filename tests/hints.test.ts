import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHints, type HintContext } from '../src/utils/hints.js';

const IDLE = 'Enter send · / commands · @ files · Tab mode · ? help';

test('idle context lists discovery shortcuts in priority order', () => {
  assert.equal(formatHints({}), IDLE);
  assert.equal(formatHints({ busy: false, streaming: false }), IDLE);
});

test('busy and streaming contexts switch to abort and scroll', () => {
  assert.equal(formatHints({ busy: true }), 'Esc abort · ↑/↓ scroll');
  assert.equal(formatHints({ streaming: true }), 'Esc abort · ↑/↓ scroll');
  assert.doesNotMatch(formatHints({ busy: true }), /commands|help|send/);
});

test('queue cue appears only for a positive, finite queue count', () => {
  assert.equal(formatHints({ busy: true, queueCount: 3 }), 'Esc abort · ↑/↓ scroll · Tab queue 3');
  assert.equal(formatHints({ streaming: true, queueCount: 1 }), 'Esc abort · ↑/↓ scroll · Tab queue 1');
  for (const count of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, 2.9]) {
    if (count === 2.9) {
      assert.match(formatHints({ busy: true, queueCount: count }), /Tab queue 2/);
    } else {
      assert.doesNotMatch(formatHints({ busy: true, queueCount: count }), /queue/);
    }
  }
  assert.doesNotMatch(formatHints({}, { width: 100 }), /queue/);
});

test('plan mode adds a badge in every context', () => {
  assert.equal(formatHints({ planMode: true }), `[PLAN] ${IDLE}`);
  assert.equal(
    formatHints({ busy: true, planMode: true, queueCount: 2 }),
    '[PLAN] Esc abort · ↑/↓ scroll · Tab queue 2',
  );
  assert.match(formatHints({ dialog: 'approval', planMode: true }), /^\[PLAN\] Esc close/);
});

test('dialog contexts narrow the strip to dialog-valid keys', () => {
  for (const dialog of ['approval', 'ask', 'settings', 'key', 'subagent'] as const) {
    const line = formatHints({ dialog, busy: true, queueCount: 4 });
    assert.equal(line, 'Esc close · ↑/↓ move · Enter select · 1-9 choose');
    for (const forbidden of ['/ commands', '@ files', 'Tab mode', '? help', 'queue']) {
      assert.doesNotMatch(line, new RegExp(forbidden.replace(/[/*?]/g, '\\$&')));
    }
  }
});

test('pickers and active search narrow to navigation keys', () => {
  assert.equal(formatHints({ picker: 'files' }), 'Esc close · ↑/↓ move · Enter select · 1-9 choose');
  assert.equal(formatHints({ picker: 'models', searchActive: true }), 'Esc close · ↑/↓ move · Enter select · 1-9 choose');
  assert.equal(formatHints({ searchActive: true }), 'Esc close · ↑/↓ move · Enter select');
  assert.equal(formatHints({ searchActive: true, busy: true }), 'Esc close · ↑/↓ move · Enter select');
});

test('width clipping drops low-priority pairs from the right with an ellipsis', () => {
  const tight = formatHints({}, { width: 30 });
  assert.equal(tight, 'Enter send · / commands …');
  assert.ok(tight.length <= 30);
  assert.match(formatHints({}, { width: 15 }), /^Enter send …$/);
  const busy = formatHints({ busy: true, queueCount: 5 }, { width: 28 });
  assert.match(busy, /^Esc abort · ↑\/↓ scroll …$/);
  assert.doesNotMatch(busy, /queue/);
});

test('plan badge survives clipping and the line never exceeds the width', () => {
  const line = formatHints({ planMode: true }, { width: 20 });
  assert.equal(line, '[PLAN] Enter send …');
  assert.ok(line.length <= 20);
  assert.ok(line.startsWith('[PLAN]'));
});

test('every usable width yields exactly one non-empty, bounded line', () => {
  for (let width = 11; width <= 120; width++) {
    for (const ctx of [{}, { busy: true }, { planMode: true }, { dialog: 'ask' as const }]) {
      for (const widthOverride of [width, width + 3]) {
        const line = formatHints(ctx, { width: widthOverride });
        assert.ok(line.length > 0, `empty at ${widthOverride}`);
        assert.ok(line.length <= widthOverride, `too wide: ${line}`);
        assert.equal(line.split('\n').length, 1);
      }
    }
  }
});

test('compact context shortens each hint set', () => {
  assert.equal(formatHints({ compact: true }), 'Enter send · / commands · @ files');
  assert.equal(formatHints({ busy: true, queueCount: 2, compact: true }), 'Esc abort · Tab queue 2');
  assert.equal(formatHints({ dialog: 'ask', compact: true }), 'Esc close · Enter select');
});

test('keybind overrides remap actions and ignore malformed values', () => {
  assert.equal(
    formatHints({}, { keybinds: { help: 'ctrl+h', mode: 'ctrl+m' } }),
    'Enter send · / commands · @ files · Ctrl+M mode · Ctrl+H help',
  );
  assert.equal(
    formatHints({ busy: true, queueCount: 2 }, { keybinds: { abort: 'ctrl+x', queue: 'ctrl+q' } }),
    'Ctrl+X abort · ↑/↓ scroll · Ctrl+Q queue 2',
  );
  const bad = { help: 42, mode: null, abort: '', scroll: 'bad key!' } as unknown as Record<string, string>;
  assert.equal(formatHints({}, { keybinds: bad }), IDLE);
  assert.equal(formatHints({ busy: true }, { keybinds: bad }), 'Esc abort · ↑/↓ scroll');
});

test('malformed context, width and options never throw', () => {
  assert.equal(formatHints(null as unknown as HintContext), IDLE);
  assert.equal(formatHints(undefined as unknown as HintContext), IDLE);
  assert.equal(formatHints(1 as unknown as HintContext), IDLE);
  assert.equal(formatHints({ picker: 3, queueCount: Number.NaN } as unknown as HintContext), IDLE);
  assert.equal(formatHints({}, { width: Number.NaN }), IDLE);
  assert.equal(formatHints({}, { width: -4 }), IDLE);
  assert.equal(formatHints({}, { width: 0 }).length > 0, true);

  const hostile = {
    get planMode(): boolean { throw new Error('bad getter'); },
  } as unknown as HintContext;
  const line = formatHints(hostile);
  assert.ok(line.length > 0);
  assert.equal(line.split('\n').length, 1);

  const hostileBinds = new Proxy({}, { get() { throw new Error('bad keybind'); } }) as Record<string, string>;
  assert.equal(formatHints({}, { keybinds: hostileBinds }), IDLE);
});

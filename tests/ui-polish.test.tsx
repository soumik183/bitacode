import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DialogList, HintLine } from '../src/components/Dialog.js';
import { Palette, SLASH_COMMANDS, highlightMatch } from '../src/components/Palette.js';
import {
  ACTIVITY_LABELS,
  LiveStatus,
  activityLabel,
  formatElapsed,
  liveStatusText,
  liveStatusCandidates,
  spinnerGlyph,
  toolObject,
  toolVerb,
} from '../src/components/LiveStatus.js';
import { TodoPanel, todoPanelRows } from '../src/components/TodoPanel.js';
import { providerKeyUrl } from '../src/components/ApiKeyPrompt.js';
import { fixedChromeRows, splitLiveArea } from '../src/utils/layout.js';
import type { TodoItem } from '../src/tools/todo.js';

const frameOf = (node: React.ReactElement): string => stripAnsi(render(node).lastFrame() ?? '');
const lines = (frame: string): string[] => frame.split('\n');

// ─── Activity strip ──────────────────────────────────────────────────

test('activity strip is exactly one row and names the current phase', () => {
  const thinking = frameOf(
    <LiveStatus columns={60} activity="thinking" elapsedMs={4200} frame={3} />
  );
  assert.equal(lines(thinking).length, 1, 'one row only');
  assert.match(thinking, /Working/);
  assert.match(thinking, /4s/);
  assert.match(thinking, /esc to interrupt/);

  const tool = frameOf(
    <LiveStatus columns={60} activity="tool" tool="bash" elapsedMs={61_000} frame={0} />
  );
  assert.match(tool, /Building/);
  assert.doesNotMatch(tool, /Building bash/, 'no tool name after a bare phase');
  assert.match(tool, /1m01s/);

  const streaming = frameOf(
    <LiveStatus columns={60} activity="streaming" tps="42 tok/s" frame={0} />
  );
  assert.match(streaming, /Working/);
  assert.match(streaming, /42 tok\/s/);
});

test('activity text and glyphs are stable and never wrap', () => {
  assert.equal(liveStatusText({ activity: 'thinking' }), 'Working');
  assert.equal(liveStatusText({ activity: 'thinking', elapsedMs: 900 }), 'Working');
  assert.equal(liveStatusText({ activity: 'tool', tool: 'grep' }), 'Searching files');
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(125_000), '2m05s');
  assert.equal(spinnerGlyph(0, false), '◐', 'no animation = static glyph');
  assert.notEqual(spinnerGlyph(0, true), spinnerGlyph(1, true), 'frames advance');

  const narrow = frameOf(<LiveStatus columns={18} activity="tool" tool="a-very-long-tool-name" />);
  assert.equal(lines(narrow).length, 1, 'narrow terminals truncate instead of wrapping');
  assert.ok(
    Math.max(...lines(narrow).map((line) => line.length)) <= 18,
    'never wider than the terminal'
  );
});

test('reserving the strip never lets the live area overlap the composer', () => {
  for (const height of [8, 10, 14, 24, 40, 60]) {
    for (const status of [0, 1]) {
      const split = splitLiveArea(height, {
        todos: 2,
        thinking: 0,
        help: 0,
        streaming: 0,
        status,
        composer: 2,
      });
      const total = split.transcriptRows + split.liveRows + fixedChromeRows({ status: 0 });
      assert.ok(total <= height, `h=${height} status=${status} overflows (${total} > ${height})`);
      assert.ok(split.transcriptRows >= 1, 'at least one transcript row survives');
      assert.ok(
        split.liveRows <= Math.max(0, height - fixedChromeRows() - 1),
        'live column never eats the last transcript row'
      );
    }
  }
});

// ─── Command palette ─────────────────────────────────────────────────

test('palette groups commands by category and keeps hints on one row each', () => {
  const items = SLASH_COMMANDS.slice(0, 6).map((cmd) => ({
    id: cmd.name,
    label: cmd.name,
    description: cmd.description,
    section: cmd.category,
  }));
  const frame = frameOf(<Palette items={items} selected={2} query="/" />);
  assert.match(frame, /Session|Model|App/, 'a category caption is rendered');
  assert.match(frame, /› \/\w+/, 'the selected row has a pointer');
  assert.match(frame, /enter run/, 'key hints are present');
  for (const line of lines(frame).slice(1)) {
    // every option row stays on one screen row: descriptions are inline
    assert.ok(line.length <= 120);
  }
});

test('palette highlights the typed match and windows long lists', () => {
  assert.deepEqual(highlightMatch('/model', '/mo'), [
    { text: '/mo', match: true },
    { text: 'del', match: false },
  ]);
  assert.deepEqual(highlightMatch('/model', '/xyz'), [{ text: '/model', match: false }]);
  const items = SLASH_COMMANDS.map((cmd) => ({
    id: cmd.name,
    label: cmd.name,
    description: cmd.description,
    section: cmd.category,
  }));
  const frame = frameOf(<Palette items={items} selected={0} maxVisible={4} query="/m" />);
  assert.match(frame, /↓ \d+ more/, 'overflow marker below');
  assert.match(frame, /1\/\d+/, 'position chip');
});

// ─── Dialog list ─────────────────────────────────────────────────────

test('dialog list marks the active row and dims descriptions inline', () => {
  const frame = frameOf(
    <DialogList
      items={[
        { id: 'gpt', label: 'gpt-5', meta: '200k', active: true },
        { id: 'mini', label: 'gpt-5-mini', meta: '128k', description: 'fast' },
      ]}
      selected={1}
    />
  );
  assert.match(frame, /gpt-5\s+200k ✓/, 'active row carries a check');
  assert.match(frame, /gpt-5-mini · fast/, 'description stays on the same row');
  assert.match(frame, /› gpt-5-mini/);
});

test('hint line paints keys and actions separately', () => {
  const frame = frameOf(<HintLine hint="enter save · esc cancel" />);
  assert.match(frame, /enter save/);
  assert.match(frame, /esc cancel/);
  assert.match(frame, /·/);
});

// ─── Todo panel ──────────────────────────────────────────────────────

test('todo panel header shows progress, priorities and the running task', () => {
  const todos: TodoItem[] = [
    { id: '1', content: 'write parser', status: 'completed', priority: 'high' },
    { id: '2', content: 'wire the loop', status: 'in_progress', priority: 'medium' },
    { id: '3', content: 'ship it', status: 'pending', priority: 'low' },
  ];
  const frame = frameOf(<TodoPanel todos={todos} columns={80} maxVisible={3} />);
  assert.match(frame, /Tasks/);
  assert.match(frame, /1\/3 done/);
  assert.match(frame, /33%/);
  assert.match(frame, /▤/);
  assert.match(frame, /P1|P2|P3/, 'priority chip is rendered');
  assert.match(frame, /wire the loop/);
  assert.match(frame, /2 in progress/);
});

test('todo panel row budget matches what it renders', () => {
  const cases: TodoItem[][] = [
    [],
    [{ id: '1', content: 'only', status: 'pending', priority: 'low' }],
    [
      { id: '1', content: 'done', status: 'completed', priority: 'low' },
      { id: '2', content: 'active', status: 'in_progress', priority: 'high' },
    ],
    Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      content: `task ${i}`,
      status: i === 0 ? ('in_progress' as const) : ('pending' as const),
      priority: 'medium' as const,
    })),
  ];
  for (const todos of cases) {
    const frame = frameOf(<TodoPanel todos={todos} columns={60} maxVisible={4} />);
    const rendered = todos.length === 0 ? 0 : lines(frame).length;
    assert.equal(todoPanelRows(todos, 4), rendered, `rows mismatch for ${todos.length} todos`);
  }
});

// ─── API key prompt ──────────────────────────────────────────────────

test('api key prompt links the provider key page, and stays quiet when unknown', () => {
  assert.equal(providerKeyUrl('OpenRouter'), 'openrouter.ai/keys');
  assert.equal(providerKeyUrl('Anthropic'), 'console.anthropic.com/settings/keys');
  assert.equal(providerKeyUrl('Google Gemini'), 'aistudio.google.com/apikey');
  assert.equal(providerKeyUrl('Some Local Server'), undefined);
});

// ─── Themes ──────────────────────────────────────────────────────────

test('every palette is audited for readable contrast', async () => {
  const { themes } = await import('../src/theme/palettes.js');
  const { auditTheme } = await import('../src/theme/contrast.js');
  for (const [name, theme] of Object.entries(themes)) {
    const audit = auditTheme(theme);
    assert.ok(audit.ok, `${name}: ${JSON.stringify(audit.issues)}`);
  }
});

test('palette text is never identical between semantic status colours', async () => {
  const { themes } = await import('../src/theme/palettes.js');
  for (const [name, theme] of Object.entries(themes)) {
    const status = [theme.success, theme.error, theme.info, theme.accent];
    assert.equal(new Set(status).size, status.length, `${name} reuses a status colour`);
  }
});

test('dialog bodies never exceed the terminal width', () => {
  const frame = frameOf(
    <DialogList
      items={Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        label: `an extremely long model identifier number ${i}`,
        meta: '200000',
      }))}
      selected={11}
    />
  );
  assert.ok(frame.length > 0);
  for (const line of lines(frame)) {
    assert.ok(line.length <= 400, `runaway line: ${line.length}`);
  }
  assert.ok(frameOf(<Text>ok</Text>).includes('ok'));
});

test('activity labels use a small fixed vocabulary and map tools to verbs', () => {
  // Exactly the phases the user asked for, and nothing invented.
  assert.deepEqual([...ACTIVITY_LABELS], [
    'Working',
    'Building',
    'Reading',
    'Writing',
    'Editing',
    'Searching',
    'Planning',
    'Delegating sub-agents',
  ]);

  // Reasoning, replies and startup all read "Working" — no rotation, so the
  // strip never pretends the phase changed when it did not.
  for (const activity of ['thinking', 'streaming', 'waiting'] as const) {
    assert.equal(activityLabel({ activity, elapsedMs: 0 }), 'Working');
    assert.equal(activityLabel({ activity, elapsedMs: 30_000 }), 'Working');
  }

  // Tools never leak snake_case into the status row.
  assert.equal(toolVerb('read_file'), 'Reading');
  assert.equal(toolVerb('search_files'), 'Searching');
  assert.equal(toolVerb('edit_file'), 'Editing');
  assert.equal(toolVerb('write_file'), 'Writing');
  assert.equal(toolVerb('bash'), 'Building');
  assert.equal(toolVerb('update_todo'), 'Planning');
  assert.equal(toolVerb('sub_agent'), 'Delegating sub-agents');
  assert.equal(toolVerb('mcp__github__issues'), 'Working');
  assert.equal(toolVerb('my_custom_tool'), 'Working');
  assert.equal(toolObject('read_file'), 'file');
  assert.equal(toolObject('search_files'), 'files');
  assert.equal(toolObject('some_custom_tool'), 'some custom tool');
  assert.equal(
    liveStatusText({ activity: 'tool', tool: 'edit_file', elapsedMs: 61_000, hint: 'esc to interrupt' }),
    'Editing file · 1m01s · esc to interrupt'
  );
  assert.equal(
    activityLabel({ activity: 'tool', tool: 'sub_agent' }),
    'Delegating sub-agents',
    'no redundant object after the delegating label'
  );

  // Narrow terminals drop hint → throughput → clock, in that order.
  const candidates = liveStatusCandidates({
    activity: 'streaming',
    elapsedMs: 6_000,
    tps: '38 tok/s',
    hint: 'esc to interrupt',
  });
  assert.deepEqual(candidates, [
    'Working · 38 tok/s · 6s · esc to interrupt',
    'Working · 38 tok/s · 6s',
    'Working · 6s',
    'Working',
  ]);
});

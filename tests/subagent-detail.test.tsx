import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import type { SubAgentRunRecord } from '../src/utils/subagent-store.js';
import { SubAgentDetail } from '../src/components/SubAgentDetail.js';
import { settle } from './helpers/wait.js';

const fixture = (): SubAgentRunRecord => ({
  id: 'sub-1',
  sessionId: 'main-1',
  task: 'Review the login flow',
  label: 'login review',
  agentType: 'Review',
  status: 'done',
  startedAt: 1000,
  endedAt: 2400,
  messageCount: 5,
  usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, estimatedCost: 0.01 },
  messages: [
    { role: 'system', content: 'YOU ARE A REVIEWER. Check every edge case.' },
    { role: 'user', content: 'Review the login flow' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          function: { name: 'read_file', arguments: JSON.stringify({ path: '/src/login.ts' }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'line one\nline two' },
    { role: 'assistant', content: 'Looks good overall.' },
  ],
});

function mount(
  record: SubAgentRunRecord,
  onBack: () => void = () => {},
  options: { columns?: number; height?: number } = {}
) {
  const view = render(
    <ThemeProvider name="black">
      <SubAgentDetail
        record={record}
        columns={options.columns ?? 80}
        height={options.height ?? 24}
        onBack={onBack}
      />
    </ThemeProvider>
  );
  const frame = (): string => stripAnsi(view.lastFrame() ?? '');
  return { view, frame };
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour12: false });

test('detail card shows status, task, badge, label, id, timestamps, usage, tool call and collapsed system prompt', async () => {
  const { view, frame } = mount(fixture());
  await settle(30);
  const text = frame();
  assert.match(text, /done/, 'status in header');
  assert.match(text, /\[Review\]/, 'agent-type badge');
  assert.match(text, /Review the login flow/);
  assert.match(text, /login review ·/, 'label shown when it differs from task');
  assert.match(text, /#sub-1/, 'short id');
  assert.match(text, /5 msgs/, 'message count');
  assert.match(
    text,
    new RegExp(`${clock(1000)}→${clock(2400)} 1\\.4s`),
    'started/ended local times plus duration'
  );
  assert.match(text, /in 1200 \/ out 300 \/ total 1500 \/ \$0\.01/, 'full usage breakdown');
  assert.match(text, /◆ read_file/, 'tool call name');
  assert.match(text, /\/src\/login\.ts/, 'path argument shown prominently');
  assert.match(text, /← read_file #call-1/, 'result linked to its call');
  assert.match(text, /line one/, 'tool result rendered');
  assert.match(text, /System prompt · 42 chars — press s to expand/, 'system collapsed');
  assert.doesNotMatch(text, /YOU ARE A REVIEWER/, 'raw system prompt hidden');
  assert.match(text, /r results/, 'hint line advertises the result toggle');
  assert.equal(text.split('\n').length, 24, 'card occupies exactly the requested rows');
  view.unmount();
});

test('pressing s expands the full system prompt with wrapping', async () => {
  const { view, frame } = mount(fixture(), () => {}, { height: 30 });
  await settle(30);
  view.stdin.write('s');
  await settle(60);
  const text = frame();
  assert.match(text, /YOU ARE A REVIEWER/, 'system text revealed');
  assert.match(text, /▾ System prompt/);
  assert.doesNotMatch(text, /press s to expand/);
  view.unmount();
});

test('error and distinct label appear in the header', async () => {
  const record: SubAgentRunRecord = {
    ...fixture(),
    id: 'agent-12345678',
    task: 'Different task text',
    label: 'Task 1/2',
    status: 'error',
    error: 'boom',
  };
  const { view, frame } = mount(record);
  await settle(30);
  const text = frame();
  assert.match(text, /Task 1\/2/, 'label');
  assert.match(text, /#12345678/, 'short id is the id tail');
  assert.match(text, /Different task text/, 'task still visible');
  assert.match(text, /in 1200 \/ out 300 \/ total 1500 \/ \$0\.01/, 'usage breakdown');
  assert.match(text, /✗ boom/, 'error shown prominently');
  view.unmount();
});

test('all tool arguments render and r expands a result past the 8-line preview', async () => {
  const lines = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'HIDDEN_NINE', 'tenth'];
  const record: SubAgentRunRecord = {
    ...fixture(),
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-5',
            function: {
              name: 'search_files',
              arguments: JSON.stringify({
                path: '/src/login.ts',
                query: 'login',
                limit: 10,
                recursive: true,
                reason: 'fifth argument',
              }),
            },
          },
        ],
      },
      { role: 'tool', name: 'search_files', tool_call_id: 'call-5', content: lines.join('\n') },
    ],
  };
  const { view, frame } = mount(record, () => {}, { height: 30 });
  await settle(30);
  let text = frame();
  assert.match(text, /◆ search_files/, 'tool name');
  assert.match(text, /query: login/);
  assert.match(text, /limit: 10/);
  assert.match(text, /recursive: true/);
  assert.match(text, /reason: fifth argument/, 'fifth argument is not capped');
  assert.match(text, /← search_files #call-5/, 'result shows name and call id');
  assert.match(text, /first/, 'preview shows result head');
  assert.match(text, /… 2 more lines/, 'preview reports hidden lines');
  assert.doesNotMatch(text, /HIDDEN_NINE/, 'preview hides lines past eight');

  view.stdin.write('r');
  await settle(60);
  text = frame();
  assert.match(text, /HIDDEN_NINE/, 'r reveals the hidden line');
  assert.match(text, /tenth/, 'r reveals the full tail');
  assert.doesNotMatch(text, /… 2 more lines/, 'no hidden-line marker when expanded');
  view.unmount();
});

test('two calls with later results do not cross-match', async () => {
  const record: SubAgentRunRecord = {
    ...fixture(),
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'alpha_read', arguments: JSON.stringify({ path: '/alpha' }) } }],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-B', function: { name: 'beta_read', arguments: JSON.stringify({ path: '/beta' }) } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-B', content: 'RESULT_BETA' },
      { role: 'tool', content: 'RESULT_ALPHA' },
    ],
  };
  const { view, frame } = mount(record, () => {}, { height: 30 });
  await settle(30);
  const text = frame();
  const alphaCall = text.indexOf('alpha_read');
  const alphaResult = text.indexOf('RESULT_ALPHA');
  const betaCall = text.indexOf('beta_read');
  const betaResult = text.indexOf('RESULT_BETA');
  assert.ok(alphaCall >= 0 && betaCall >= 0, 'both calls rendered');
  assert.ok(alphaResult >= 0 && betaResult >= 0, 'both results rendered');
  assert.ok(
    alphaCall < alphaResult && alphaResult < betaCall && betaCall < betaResult,
    `each result stayed with its own call:\n${text}`
  );
  view.unmount();
});

test('a tiny terminal drops the border and keeps the card within its row budget', async () => {
  const { view, frame } = mount(fixture(), () => {}, { height: 8 });
  await settle(30);
  const text = frame();
  assert.doesNotMatch(text, /╭|╰/, 'no rounded border');
  assert.doesNotMatch(text, /─{4,}/, 'no rules');
  assert.match(text, /Review the login flow/, 'compact header');
  assert.match(text, /esc back/, 'compact hint');
  const rows = text.split('\n').length;
  assert.ok(rows <= 8, `card fits within 8 rows, got ${rows}:\n${text}`);
  view.unmount();
});

test('pressing Escape calls onBack', async () => {
  let backs = 0;
  const { view } = mount(fixture(), () => { backs += 1; });
  await settle(30);
  view.stdin.write('\u001B');
  await settle(40);
  assert.equal(backs, 1);
  view.unmount();
});

test('an empty transcript is handled gracefully', async () => {
  const record = { ...fixture(), messages: [], messageCount: 0 };
  const { view, frame } = mount(record);
  await settle(30);
  assert.match(frame(), /No transcript recorded\./);
  view.unmount();
});

test('a long tool result never paints over the bottom border', async () => {
  const record = fixture();
  record.messages = [
    ...record.messages.slice(0, 3),
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'),
    },
    { role: 'assistant', content: 'Done.' },
  ];
  const { view, frame } = mount(record, undefined, { height: 22 });
  await settle(40);
  const rows = frame().split('\n');
  assert.equal(rows.length, 22, 'the card keeps its exact height');
  assert.match(rows[rows.length - 1] ?? '', /╰─+╯/, 'bottom border is clean');
  assert.doesNotMatch(rows[rows.length - 1] ?? '', /line \d+/, 'no result text leaks onto the border');
  assert.match(frame(), /◆ read_file/, 'call header is still visible');
  view.unmount();
});

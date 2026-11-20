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

function mount(record: SubAgentRunRecord, onBack: () => void = () => {}) {
  const view = render(
    <ThemeProvider name="black">
      <SubAgentDetail record={record} columns={80} height={24} onBack={onBack} />
    </ThemeProvider>
  );
  const frame = (): string => stripAnsi(view.lastFrame() ?? '');
  return { view, frame };
}

test('detail card shows status, task, badge, tool call and collapsed system prompt', async () => {
  const { view, frame } = mount(fixture());
  await settle(30);
  const text = frame();
  assert.match(text, /done/, 'status in header');
  assert.match(text, /\[Review\]/, 'agent-type badge');
  assert.match(text, /Review the login flow/);
  assert.match(text, /5 msgs · 1\.4s · 1\.5k tok · \$0\.01/, 'meta line');
  assert.match(text, /◆ read_file/, 'tool call name');
  assert.match(text, /\/src\/login\.ts/, 'path argument shown prominently');
  assert.match(text, /line one/, 'tool result rendered');
  assert.match(text, /System prompt · 42 chars — press s to expand/, 'system collapsed');
  assert.doesNotMatch(text, /YOU ARE A REVIEWER/, 'raw system prompt hidden');
  assert.match(text, /esc back/, 'hint line');
  assert.equal(text.split('\n').length, 24, 'card occupies exactly the requested rows');
  view.unmount();
});

test('pressing s expands the system prompt', async () => {
  const { view, frame } = mount(fixture());
  await settle(30);
  view.stdin.write('s');
  await settle(40);
  const text = frame();
  assert.match(text, /YOU ARE A REVIEWER/, 'system text revealed');
  assert.match(text, /▾ System prompt/);
  assert.doesNotMatch(text, /press s to expand/);
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

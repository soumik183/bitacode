import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import {
  SubAgentActivity,
  subAgentActivityRows,
  upsertSubAgentActivity,
  type SubAgentActivityItem,
} from '../src/components/SubAgentActivity.js';
import { settle } from './helpers/wait.js';

test('upsert threads subAgentType and preserves it when later events omit it', () => {
  const first = upsertSubAgentActivity(
    [],
    { subAgentId: 'sa-1', subAgentTask: 'Review diff', subAgentType: 'Review' },
    1000
  );
  assert.equal(first[0].agentType, 'Review');
  const second = upsertSubAgentActivity(first, { subAgentId: 'sa-1', subAgentStatus: 'done' }, 2000);
  assert.equal(second[0].agentType, 'Review', 'existing agent type survives an event without one');
  assert.equal(second[0].status, 'done');
});

test('activity header keeps its row budget while showing count, hint and type badge', async () => {
  const activities: SubAgentActivityItem[] = [
    { id: 'sa-1', task: 'Review diff', status: 'start', startedAt: 1000, agentType: 'Review' },
    { id: 'sa-2', task: 'Run tests', status: 'done', startedAt: 1000, endedAt: 1200 },
  ];
  const view = render(
    <ThemeProvider name="black">
      <SubAgentActivity activities={activities} columns={80} now={1500} />
    </ThemeProvider>
  );
  await settle(30);
  const text = stripAnsi(view.lastFrame() ?? '');
  assert.match(text, /Sub-agents/);
  assert.match(text, /\b2\b/, 'count chip');
  assert.match(text, /\^g all/, 'hint sits on the header row');
  assert.match(text, /\[Review\] Review diff/);
  assert.match(text, /Run tests/);
  assert.equal(text.split('\n').length, subAgentActivityRows(activities), 'no extra rows added');
  view.unmount();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { plan, getPlanForSession } from '../src/tools/plan.js';
import { runParallel, setParallelExecutor } from '../src/tools/parallel.js';
import { recordSubAgentStatus, agentStatus } from '../src/tools/agent-status.js';
import { agentMessage, getQueuedMessages, clearQueuedMessages } from '../src/tools/agent-message.js';
import { taskResult } from '../src/tools/task-result.js';
import { notify, isNotification } from '../src/tools/notify.js';
import { progress, parseProgress } from '../src/tools/progress.js';
import { openUrl } from '../src/tools/open-url.js';
import { saveSubAgentRun, type SubAgentRunInput } from '../src/utils/subagent-store.js';

test('plan stores a session plan and formats numbered checkbox steps', async () => {
  const result = await plan(
    { goal: 'Ship it', steps: ['write code', 'run tests'], notes: 'be quick' },
    { sessionId: 'plan-session-1' },
  );
  assert.match(result, /# Implementation Plan/);
  assert.match(result, /Goal: Ship it/);
  assert.match(result, /1\. \[ \] write code/);
  assert.match(result, /2\. \[ \] run tests/);
  assert.match(result, /Notes: be quick/);

  const stored = getPlanForSession('plan-session-1');
  assert.deepEqual(stored?.steps, ['write code', 'run tests']);
  assert.equal(stored?.goal, 'Ship it');
  // Snapshots cannot mutate the registry.
  stored!.steps.push('extra');
  assert.deepEqual(getPlanForSession('plan-session-1')!.steps, ['write code', 'run tests']);

  assert.match(await plan({ goal: '', steps: [] }), /^Error:/);
  assert.match(await plan({ goal: 'x', steps: [] }), /^Error:/);
  const tooMany = Array.from({ length: 51 }, (_, i) => `step ${i}`);
  assert.match(await plan({ goal: 'x', steps: tooMany }), /^Error: too many steps/);
});

test('parallel caps concurrency at 4, keeps order, and never throws', async () => {
  let active = 0;
  let peak = 0;
  setParallelExecutor(async (name: string) => {
    active++;
    peak = Math.max(peak, active);
    const delay = name === 'tool-2' ? 15 : 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return `ok-${name}`;
  });
  try {
    const calls = Array.from({ length: 6 }, (_, i) => ({ name: `tool-${i}`, arguments: { i } }));
    const result = await runParallel({ calls });
    assert.equal(peak, 4, 'no more than 4 calls in flight');
    const positions = calls.map((c) => result.indexOf(`[${c.name}]`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'results in original order');
    for (const c of calls) assert.match(result, new RegExp(`ok-${c.name}`));

    // A rejected call becomes an inline Error line; the rest still succeed.
    setParallelExecutor(async (name: string) => {
      if (name === 'bad') throw new Error('boom');
      return 'fine';
    });
    const mixed = await runParallel({ calls: [{ name: 'bad' }, { name: 'good' }] });
    assert.match(mixed, /1\. \[bad\] Error: boom/);
    assert.match(mixed, /2\. \[good\] fine/);

    assert.match(await runParallel({ calls: new Array(9).fill({ name: 'x' }) }), /^Error: too many parallel calls/);
    assert.match(await runParallel({ calls: 'nope' }), /^Error:/);
    setParallelExecutor(null);
    assert.match(await runParallel({ calls: [{ name: 'x' }] }), /not configured/);
  } finally {
    setParallelExecutor(null);
  }
});

test('agent_status and agent_message use the exported registries', async () => {
  recordSubAgentStatus('agent-status-1', 'fix bug', 'running', 3);
  recordSubAgentStatus('agent-status-2', 'write tests', 'done', 7);
  recordSubAgentStatus('agent-status-1', 'fix bug', 'done', 5); // update, not duplicate

  const listed = await agentStatus({});
  assert.match(listed, /agent-status-1/);
  assert.match(listed, /write tests/);
  assert.match(listed, /TOOLS/);
  assert.match(listed, /Sub-agent activity \(2\):/);

  const filtered = await agentStatus({ id: 'agent-status-1' });
  assert.match(filtered, /agent-status-1/);
  assert.doesNotMatch(filtered, /agent-status-2/);
  assert.match(await agentStatus({ id: 'missing-agent' }), /No sub-agent activity/);

  clearQueuedMessages('agent-status-1');
  const queued = await agentMessage({ id: 'agent-status-1', message: 'please pause' });
  assert.match(queued, /Message queued for sub-agent "agent-status-1"/);
  assert.match(queued, /no running process was interrupted/);
  assert.deepEqual(getQueuedMessages('agent-status-1'), ['please pause']);
  assert.match((await agentStatus({ id: 'agent-status-1' })).split('\n').at(-1) ?? '', /1\s*$/);

  assert.match(await agentMessage({ id: '', message: 'x' }), /^Error:/);
  assert.match(await agentMessage({ id: 'x', message: '' }), /^Error:/);
  clearQueuedMessages('agent-status-1');
});

test('task_result reads a saved run from a temp HOME and never throws', async () => {
  const originalHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-task-tools-'));
  (os as any).homedir = () => tempHome;
  try {
    const record: SubAgentRunInput = {
      sessionId: 'resultsession1',
      id: 'sub-result-1',
      task: 'investigate crash',
      label: '1/1',
      status: 'done',
      startedAt: 1_000,
      endedAt: 2_000,
      messages: [
        { role: 'user', content: 'investigate crash' },
        { role: 'assistant', content: 'found the bug' },
      ],
    };
    assert.equal(await saveSubAgentRun(record), true);

    const result = await taskResult({ id: 'sub-result-1', session_id: 'resultsession1' });
    assert.match(result, /Sub-agent result — sub-result-1/);
    assert.match(result, /status: done/);
    assert.match(result, /task: investigate crash/);
    assert.match(result, /TRANSCRIPT SUMMARY/);
    assert.match(result, /assistant: found the bug/);
    assert.match(result, /messages: 2/);

    assert.match(await taskResult({ id: 'sub-nope', session_id: 'resultsession1' }), /not found/);
    assert.match(await taskResult({ id: '../escape', session_id: 'resultsession1' }), /invalid or missing sub-agent id/);
    assert.match(await taskResult({ id: 'sub-result-1', session_id: '../escape' }), /^Error: invalid or missing session_id/);
  } finally {
    (os as any).homedir = originalHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('notify and progress helpers parse their own output', async () => {
  const note = await notify({ message: 'Build finished', title: 'CI' });
  assert.equal(note, 'NOTIFY: CI: Build finished');
  assert.equal(isNotification(note), true);
  assert.equal(isNotification('just text'), false);
  assert.match(await notify({ message: '' }), /^Error:/);

  const line = await progress({ percent: 60, label: 'writing tests' });
  assert.match(line, /^PROGRESS: \[██████░░░░\] 60% — writing tests$/);
  assert.deepEqual(parseProgress(line), { percent: 60, label: 'writing tests' });
  assert.deepEqual(parseProgress('PROGRESS: [░░░░░░░░░░] 0%'), { percent: 0, label: '' });
  assert.equal(parseProgress('not progress'), null);
  assert.match(await progress({ percent: 101 }), /^Error:/);
  assert.match(await progress({ percent: -1 }), /^Error:/);
});

test('open_url rejects non-http(s) URLs without spawning', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com', '', 42]) {
    assert.match(await openUrl({ url }), /^Error: url must be a valid http\(s\) URL/);
  }
});

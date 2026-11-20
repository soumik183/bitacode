import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveSubAgentRun,
  loadSubAgentRun,
  type SubAgentRunInput,
} from '../src/utils/subagent-store.js';
import {
  buildSubAgentSystemPrompt,
  SUB_AGENT_REVIEW_MODE,
} from '../src/sub-agent.js';

let originalHomedir: typeof os.homedir;
let tempHome: string;

test.beforeEach(() => {
  originalHomedir = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-subagent-review-test-'));
  (os as any).homedir = () => tempHome;
});

test.afterEach(() => {
  (os as any).homedir = originalHomedir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('buildSubAgentSystemPrompt appends review block only for Review agents', () => {
  const base = 'BASE SYSTEM PROMPT';

  const review = buildSubAgentSystemPrompt(base, 'Review');
  assert.ok(review.includes(base));
  assert.ok(review.includes('## Sub-Agent Mode'));
  assert.ok(review.includes(SUB_AGENT_REVIEW_MODE));
  assert.ok(review.includes('critical/high/medium/low'));
  assert.ok(review.includes('file:line'));
  assert.ok(review.includes('read_file'));
  assert.ok(review.includes('git diff'));
  assert.ok(/verdict/i.test(review));

  const plain = buildSubAgentSystemPrompt(base, undefined);
  assert.ok(plain.includes(base));
  assert.ok(plain.includes('## Sub-Agent Mode'));
  assert.ok(!plain.includes(SUB_AGENT_REVIEW_MODE));
  assert.ok(!plain.includes('## Review Mode'));

  // Other agent types remain labels — no review block.
  assert.ok(!buildSubAgentSystemPrompt(base, 'Explore').includes(SUB_AGENT_REVIEW_MODE));
});

test('tool_calls and tool result metadata round-trip through the store', async () => {
  const args = JSON.stringify({ file_path: 'src/agentic-loop.ts', offset: 10 });
  const record: SubAgentRunInput = {
    sessionId: 'main1234',
    id: 'sub-agent-review',
    task: 'review the loop',
    agentType: 'Review',
    status: 'done',
    startedAt: 1000,
    endedAt: 2000,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'review the loop' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'read_file', arguments: args },
          },
        ],
      },
      {
        role: 'tool',
        name: 'read_file',
        tool_call_id: 'call_abc123',
        content: 'file contents here',
      },
    ],
  };
  assert.equal(await saveSubAgentRun(record), true);

  const loaded = await loadSubAgentRun('main1234', 'sub-agent-review');
  assert.ok(loaded);
  assert.equal(loaded!.agentType, 'Review');

  const assistant = loaded!.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant!.tool_calls?.length, 1);
  assert.equal(assistant!.tool_calls![0].id, 'call_abc123');
  assert.equal(assistant!.tool_calls![0].type, 'function');
  assert.equal(assistant!.tool_calls![0].function?.name, 'read_file');
  assert.ok(assistant!.tool_calls![0].function?.arguments?.includes('src/agentic-loop.ts'));

  const tool = loaded!.messages.find((m) => m.role === 'tool');
  assert.ok(tool);
  assert.equal(tool!.name, 'read_file');
  assert.equal(tool!.tool_call_id, 'call_abc123');
});

test('legacy records without tool_calls or agentType still load', async () => {
  const sessionDir = path.join(tempHome, '.local', 'share', 'bitacode', 'subagents', 'main1234');
  fs.mkdirSync(sessionDir, { recursive: true });
  const legacy = {
    sessionId: 'main1234',
    id: 'sub-agent-legacy',
    task: 'old task',
    status: 'done',
    startedAt: 1000,
    messages: [
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'old answer' },
    ],
  };
  fs.writeFileSync(path.join(sessionDir, 'sub-agent-legacy.json'), JSON.stringify(legacy));

  const loaded = await loadSubAgentRun('main1234', 'sub-agent-legacy');
  assert.ok(loaded);
  assert.equal(loaded!.agentType, undefined);
  assert.equal(loaded!.messageCount, 2);
  assert.deepEqual(loaded!.messages.map((m) => m.content), ['old task', 'old answer']);
  assert.ok(loaded!.messages.every((m) => m.tool_calls === undefined));
  assert.ok(loaded!.messages.every((m) => m.name === undefined && m.tool_call_id === undefined));
});

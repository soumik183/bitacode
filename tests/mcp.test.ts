import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllTools,
  handleToolCall,
  registerDynamicHandler,
  registerDynamicTool,
  unregisterDynamicHandler,
  unregisterDynamicTool,
} from '../src/tools/index.js';
import {
  __setMcpConnectionForTests,
  closeMcp,
  isValidMcpUrl,
  mcpConfigError,
  sanitizeMcpToolName,
  uniqueToolName,
} from '../src/mcp.js';

// ─── Pure helpers ───

test('sanitizeMcpToolName folds characters OpenAI tool names disallow', () => {
  assert.equal(sanitizeMcpToolName('hello.world/tool:v1'), 'hello_world_tool_v1');
  assert.equal(sanitizeMcpToolName('already_ok-1'), 'already_ok-1');
  assert.equal(sanitizeMcpToolName('a b\tc'), 'a_b_c');
});

test('uniqueToolName suffixes collisions with _2, _3, ...', () => {
  const used = new Set<string>();
  assert.equal(uniqueToolName('mcp_s_tool', used), 'mcp_s_tool');
  assert.equal(uniqueToolName('mcp_s_tool', used), 'mcp_s_tool_2');
  assert.equal(uniqueToolName('mcp_s_tool', used), 'mcp_s_tool_3');
  assert.equal(uniqueToolName('other', used), 'other');
  assert.deepEqual([...used], ['mcp_s_tool', 'mcp_s_tool_2', 'mcp_s_tool_3', 'other']);
});

test('isValidMcpUrl rejects missing and non-http urls', () => {
  assert.equal(isValidMcpUrl(undefined), false);
  assert.equal(isValidMcpUrl(''), false);
  assert.equal(isValidMcpUrl('not a url'), false);
  assert.equal(isValidMcpUrl('ftp://example.com'), false);
  assert.equal(isValidMcpUrl('http://localhost:3000/mcp'), true);
  assert.equal(isValidMcpUrl('https://example.com/mcp'), true);
});

test('mcpConfigError flags invalid stdio/http configs without throwing', () => {
  assert.match(mcpConfigError({ type: 'stdio' })!, /missing a valid command/);
  assert.match(mcpConfigError({ type: 'stdio', command: '   ' })!, /missing a valid command/);
  assert.match(mcpConfigError({ type: 'http' })!, /missing a valid url/);
  assert.match(mcpConfigError({ type: 'http', url: 'nope' })!, /missing a valid url/);
  assert.match(mcpConfigError({ type: 'ws', url: 'http://x' })!, /unknown server type/);
  assert.match(mcpConfigError(null)!, /invalid server config/);
  assert.equal(mcpConfigError({ type: 'stdio', command: 'npx' }), null);
  assert.equal(mcpConfigError({ type: 'http', url: 'http://localhost:3000/mcp' }), null);
});

// ─── Connection cleanup (real registry, fake injected connection) ───

const TOOL_A = 'mcp_test_a_tool';
const TOOL_B = 'mcp_test_b_tool';

function addDynamicTool(name: string): void {
  registerDynamicTool({
    type: 'function',
    function: { name, description: `[MCP: test] ${name}`, parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(name, async () => 'ok');
}

function removeDynamicTool(name: string): void {
  unregisterDynamicHandler(name);
  unregisterDynamicTool(name);
}

test('closeMcp unregisters tools and handlers for closed connections', async () => {
  addDynamicTool(TOOL_A);
  let closed = false;
  __setMcpConnectionForTests('test-a', {
    client: { close: async () => { closed = true; } },
    serverName: 'test-a',
    transport: {},
    registeredToolNames: [TOOL_A],
  });

  try {
    assert.ok(getAllTools().some((t) => t.function.name === TOOL_A));
    await closeMcp();

    assert.equal(closed, true);
    assert.ok(!getAllTools().some((t) => t.function.name === TOOL_A), 'tool definition removed');
    assert.match(await handleToolCall(TOOL_A, {}), /Unknown tool/, 'handler removed');
  } finally {
    removeDynamicTool(TOOL_A);
    await closeMcp();
  }
});

test('closeMcp unregisters tools even when client.close throws', async () => {
  addDynamicTool(TOOL_B);
  __setMcpConnectionForTests('test-b', {
    client: { close: async () => { throw new Error('close failed'); } },
    serverName: 'test-b',
    transport: {},
    registeredToolNames: [TOOL_B],
  });

  try {
    await assert.doesNotReject(closeMcp());
    assert.ok(!getAllTools().some((t) => t.function.name === TOOL_B));
    assert.match(await handleToolCall(TOOL_B, {}), /Unknown tool/);
  } finally {
    removeDynamicTool(TOOL_B);
    await closeMcp();
  }
});

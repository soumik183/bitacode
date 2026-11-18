import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { editFile } from '../src/tools/edit-file.js';
import { readFile } from '../src/tools/read-file.js';
import { writeFile } from '../src/tools/write-file.js';
import { listDirectory } from '../src/tools/list-directory.js';
import { globFiles } from '../src/tools/glob.js';
import { readTodos, writeTodos } from '../src/tools/todo.js';
import {
  handleToolCall,
  registerDynamicHandler,
  registerDynamicTool,
  unregisterDynamicHandler,
  unregisterDynamicTool,
} from '../src/tools/index.js';
import { setApprovalHandler } from '../src/utils/approval.js';
import { formatToolActivity } from '../src/utils/tool-display.js';
import { getValidToolNames } from '../src/agentic-loop.js';

// File-writing tests run without a UI; approve once so they can exercise the
// real write path (path validation, atomic rename, permissions).
setApprovalHandler(async () => 'approve_once');

test('editFile rejects empty old_string', async () => {
  const result = await editFile('package.json', '', 'replacement');
  assert.match(result, /old_string cannot be empty/i);
});

test('readFile reads only the requested line range', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-read-file');
  const fixturePath = path.join(fixtureDir, 'fixture.txt');

  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n'), 'utf8');

  try {
    const result = await readFile('tests/tmp-read-file/fixture.txt', 2, 2);

    // readFile now returns raw content (no line numbers, no header)
    assert.match(result, /gamma/);
    assert.match(result, /delta/);
    assert.doesNotMatch(result, /alpha/);
    assert.doesNotMatch(result, /epsilon/);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('readFile reads multiple 1-based line ranges with validation', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-read-ranges');
  const fixturePath = path.join(fixtureDir, 'fixture.txt');
  const relativePath = 'tests/tmp-read-ranges/fixture.txt';

  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');

  try {
    const result = await readFile(relativePath, 0, 2000, undefined, '2-3, 90-91');
    assert.match(result, /\[lines 2-3\]\nline 2\nline 3/);
    assert.match(result, /\[lines 90-91\]\nline 90\nline 91/);
    assert.doesNotMatch(result, /line 1\n/);
    assert.doesNotMatch(result, /line 92/);

    assert.match(await readFile(relativePath, 0, 2000, undefined, '2-3,4-5'), /\[lines 2-5\]/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, '7'), /\[lines 7-7\]\nline 7/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, '95-120'), /line 100\n\.\.\. \(file ends at line 100\)/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, '101-105'), /no lines: file has 100 line/);

    assert.match(await readFile(relativePath, 0, 2000, undefined, '0-2'), /Line numbers start at 1/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, '5-2'), /end line must be after the start line/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, 'abc'), /invalid range/);
    assert.match(await readFile(relativePath, 0, 2000, undefined, '1-3000'), /maximum is 2000/);

    assert.match(
      await handleToolCall('read_file', { file_path: relativePath, ranges: '1-2', offset: 0 }),
      /use either ranges or offset\/limit/
    );
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('readFile rejects invalid ranges, directories, and binary files', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-read-guards');
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(path.join(fixtureDir, 'binary.bin'), Buffer.from([0x68, 0x00, 0x69]));
  await fs.symlink('/etc/passwd', path.join(fixtureDir, 'escape-link'));

  try {
    assert.match(await readFile('package.json', 0, 0), /limit must be a positive integer/i);
    assert.match(await readFile('tests/tmp-read-guards', 0, 5), /is a directory/i);
    assert.match(await readFile('tests/tmp-read-guards/binary.bin'), /binary file/i);
    assert.match(await readFile('tests/tmp-read-guards/escape-link'), /outside the working directory/i);
    assert.match(await readFile('../outside.txt'), /outside the working directory/i);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('readFile suggests the actual near-match for a typo', async () => {
  const result = await readFile('package.jsn');
  assert.match(result, /package\.json/);
});

test('writeFile creates missing parent directories and returns a diff', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-write-file');

  await fs.rm(fixtureDir, { recursive: true, force: true });
  try {
    const result = await writeFile('tests/tmp-write-file/a/b/new.txt', 'hello');
    assert.match(result, /Successfully wrote 1 lines/i);
    assert.match(result, /\+hello/);
    assert.equal(await fs.readFile(path.join(fixtureDir, 'a', 'b', 'new.txt'), 'utf8'), 'hello');

    const overwritten = await writeFile('tests/tmp-write-file/a/b/new.txt', 'goodbye');
    assert.match(overwritten, /-hello/);
    assert.match(overwritten, /\+goodbye/);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('editFile works after a session is resumed in a new process', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-edit-resume');
  const fixturePath = path.join(fixtureDir, 'file.txt');

  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, 'old text', 'utf8');

  try {
    // No in-process read record exists for this session id, which is what a
    // resumed session looks like after a restart.
    const result = await editFile(
      'tests/tmp-edit-resume/file.txt',
      'old text',
      'new text',
      1,
      'resumed-session'
    );

    assert.match(result, /Successfully edited/i);
    assert.equal(await fs.readFile(fixturePath, 'utf8'), 'new text');
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('editFile still rejects a file changed after an in-process read', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-edit-stale');
  const fixturePath = path.join(fixtureDir, 'file.txt');
  const sessionId = 'stale-session';

  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(fixturePath, 'old text', 'utf8');

  try {
    await readFile('tests/tmp-edit-stale/file.txt', 0, 2000, sessionId);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(fixturePath, future, future);

    const result = await editFile(
      'tests/tmp-edit-stale/file.txt',
      'old text',
      'new text',
      1,
      sessionId
    );

    assert.match(result, /changed on disk since you last read it/i);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('listDirectory reports a file path clearly', async () => {
  const result = await listDirectory('package.json');
  assert.match(result, /not a directory/i);
  assert.match(result, /read_file/i);
});

test('glob finds files recursively, supports braces, and skips node_modules', async () => {
  const fixtureDir = path.join(process.cwd(), 'tests', 'tmp-glob');
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureDir, 'nested'), { recursive: true });
  await fs.mkdir(path.join(fixtureDir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(fixtureDir, 'a.ts'), 'a');
  await fs.writeFile(path.join(fixtureDir, 'nested', 'b.ts'), 'b');
  await fs.writeFile(path.join(fixtureDir, 'nested', 'c.json'), '{}');
  await fs.writeFile(path.join(fixtureDir, 'node_modules', 'pkg', 'd.ts'), 'd');

  try {
    const result = await globFiles('**/*.{ts,json}', 'tests/tmp-glob');

    assert.match(result, /tests\/tmp-glob\/a\.ts/);
    assert.match(result, /tests\/tmp-glob\/nested\/b\.ts/);
    assert.match(result, /tests\/tmp-glob\/nested\/c\.json/);
    assert.doesNotMatch(result, /node_modules/);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

test('todo_write rejects invalid items without clobbering the list', () => {
  const sessionId = 'tmp-todo-validation';
  const result = writeTodos(
    [{ id: '1', content: 'task', status: 'bogus' as any, priority: 'high' }],
    sessionId,
  );

  assert.match(result, /invalid status/i);
  assert.match(readTodos(sessionId), /No TODOs/);
});

test('handleToolCall truncates oversized tool results', async () => {
  const toolName = 'tmp_big_tool';
  registerDynamicTool({
    type: 'function',
    function: { name: toolName, description: 'test', parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(toolName, async () => 'x'.repeat(60_000));

  try {
    const result = await handleToolCall(toolName, {});
    assert.ok(result.length < 51_000);
    assert.match(result, /tool result truncated/i);
  } finally {
    unregisterDynamicHandler(toolName);
    unregisterDynamicTool(toolName);
  }
});

test('handleToolCall truncation preserves the tail of oversized results', async () => {
  const toolName = 'tmp_big_tool_tail';
  registerDynamicTool({
    type: 'function',
    function: { name: toolName, description: 'test', parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(toolName, async () => `HEAD_MARKER${'x'.repeat(60_000)}TAIL_ERROR_MARKER`);

  try {
    const result = await handleToolCall(toolName, {});
    assert.ok(result.length < 51_000);
    assert.match(result, /HEAD_MARKER/);
    assert.match(result, /TAIL_ERROR_MARKER/);
    assert.match(result, /truncated/i);
  } finally {
    unregisterDynamicHandler(toolName);
    unregisterDynamicTool(toolName);
  }
});

test('handleToolCall does not call sub_agent an unknown tool', async () => {
  const result = await handleToolCall('sub_agent', {});
  assert.doesNotMatch(result, /Unknown tool/i);
  assert.match(result, /loop/i);
});

test('tool display survives a malformed webfetch URL', () => {
  assert.doesNotThrow(() => formatToolActivity('webfetch', { url: 'not a url' }));
});

test('aliases accept alias-style arg keys and map to canonical ones', async () => {
  const dir = 'tests/tmp-alias-args';
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'needle.txt'), 'ALIAS_NEEDLE_MARKER\n', 'utf8');

  try {
    // `list` accepts path (alias) and directory_path (canonical) equally.
    const viaPath = await handleToolCall('list', { path: dir });
    const viaCanonical = await handleToolCall('list', { directory_path: dir });
    assert.equal(viaPath, viaCanonical);
    assert.match(viaPath, /needle\.txt/);

    // `grep` accepts query/search_term for the term and path/directory_path for the dir.
    const viaQuery = await handleToolCall('grep', { query: 'ALIAS_NEEDLE_MARKER', path: dir });
    const viaSearchTerm = await handleToolCall('grep', { search_term: 'ALIAS_NEEDLE_MARKER', directory_path: dir });
    assert.match(viaQuery, /ALIAS_NEEDLE_MARKER/);
    assert.match(viaQuery, /needle\.txt/);
    assert.equal(viaQuery, viaSearchTerm);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown tool error suggests the closest tools, not a giant flat list', async () => {
  const result = await handleToolCall('reed_file', {});
  assert.match(result, /Unknown tool "reed_file"/);
  assert.match(result, /Did you mean:/);
  assert.match(result, /read_file/);
  assert.doesNotMatch(result, /Available tools:/);
  // One quoted tool name in the header + at most three suggestions.
  const quoted = result.match(/"[a-z0-9_]+"/g) ?? [];
  assert.ok(quoted.length <= 4, `expected <= 3 suggestions, got ${quoted.length - 1}: ${result}`);
});

test('required args are validated before dispatch with actionable errors', async () => {
  assert.match(await handleToolCall('read_file', {}), /^Error: read_file requires file_path$/);
  assert.match(await handleToolCall('write_file', { file_path: 'x' }), /^Error: write_file requires content$/);
  assert.match(await handleToolCall('grep', {}), /^Error: grep requires search_term$/);
  assert.match(await handleToolCall('bash', {}), /^Error: bash requires command$/);
});

test('handlers cannot leak undefined or non-string results', async () => {
  const undefTool = 'tmp_undefined_result_tool';
  const objTool = 'tmp_object_result_tool';
  registerDynamicTool({
    type: 'function',
    function: { name: undefTool, description: 'test', parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(undefTool, async () => undefined as any);
  registerDynamicTool({
    type: 'function',
    function: { name: objTool, description: 'test', parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(objTool, async () => ({ ok: true }) as any);

  try {
    const undefResult = await handleToolCall(undefTool, {});
    assert.equal(typeof undefResult, 'string');
    assert.match(undefResult, /returned no output/);

    const objResult = await handleToolCall(objTool, {});
    assert.equal(typeof objResult, 'string');
    assert.equal(objResult, '{"ok":true}');
  } finally {
    unregisterDynamicHandler(undefTool);
    unregisterDynamicTool(undefTool);
    unregisterDynamicHandler(objTool);
    unregisterDynamicTool(objTool);
  }
});

test('handleToolCall strips NUL bytes from results', async () => {
  const toolName = 'tmp_nul_tool';
  registerDynamicTool({
    type: 'function',
    function: { name: toolName, description: 'test', parameters: { type: 'object', properties: {} } },
  });
  registerDynamicHandler(toolName, async () => 'a\0b\0c');

  try {
    assert.equal(await handleToolCall(toolName, {}), 'abc');
  } finally {
    unregisterDynamicHandler(toolName);
    unregisterDynamicTool(toolName);
  }
});

test('getValidToolNames includes built-ins, dynamic tools and sub_agent but not aliases', () => {
  const name = 'tmp_registry_probe_tool';
  registerDynamicTool({
    type: 'function',
    function: { name, description: 'test', parameters: { type: 'object', properties: {} } },
  });

  try {
    const names = getValidToolNames();
    assert.ok(names instanceof Set);
    assert.ok(names.has('read_file'), 'built-ins included');
    assert.ok(names.has('sub_agent'), 'sub-agent tool included');
    assert.ok(names.has(name), 'dynamic tools included');
    assert.ok(!names.has('grep'), 'aliases must not be advertised');
    assert.ok(!names.has('list'), 'aliases must not be advertised');
  } finally {
    unregisterDynamicTool(name);
  }
});

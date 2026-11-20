import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  planToolBatches,
  describeBatches,
  isReadOnlyTool,
  planIsReadOnly,
} from '../src/agentic-loop/scheduler.js';
import {
  evaluatePermission,
  mergeRuleSets,
  parseRule,
  parseRuleSet,
  splitRule,
} from '../src/utils/permission-rules.js';
import {
  clearReadState,
  isFileUnchangedSinceRead,
  readRecordFor,
  recordFileRead,
  recordFileWrite,
  unchangedReadStub,
  wasFileRead,
  resetReadStateForTests,
} from '../src/utils/read-state.js';
import {
  applyToolResultBudget,
  pruneSpillFiles,
  truncateWithNote,
} from '../src/utils/tool-result-budget.js';
import { loadHooks, parseHookConfig, runHooks } from '../src/utils/hooks.js';
import {
  isProjectTrusted,
  listTrustedProjects,
  trustProject,
  untrustProject,
} from '../src/utils/project-trust.js';
import { verifyToolPostcondition } from '../src/utils/tool-verify.js';
import {
  appendJournal,
  computeJournalStats,
  readJournal,
  renderJournalReplay,
} from '../src/utils/session-journal.js';
import {
  beginTurn,
  checkpointsForRewind,
  endTurn,
  recordTurnCheckpoint,
  resolveRewind,
  truncateTurns,
} from '../src/utils/turn-snapshots.js';

/** Run a block with HOME/XDG pointed at a throwaway directory. */
async function withSandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-feature-'));
  const saved = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = dir;
  process.env.XDG_DATA_HOME = path.join(dir, 'data');
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── scheduler ───

const call = (name: string) => ({ function: { name } });

test('scheduler barriers every write and parallelises read-only calls', () => {
  const calls = [call('read_file'), call('search_files'), call('write_file'), call('read_file')];
  const batches = planToolBatches(calls);
  assert.deepEqual(batches, [
    { mode: 'parallel', indexes: [0, 1] },
    { mode: 'serial', indexes: [2] },
    { mode: 'parallel', indexes: [3] },
  ]);
  assert.equal(describeBatches(batches, calls), 'parallel[read_file,search_files] -> serial[write_file] -> parallel[read_file]');
  assert.equal(planIsReadOnly(planToolBatches([call('read_file'), call('glob')])), true);
  assert.equal(planIsReadOnly(planToolBatches([call('bash')])), false);
});

test('scheduler treats unknown tools as writes unless told otherwise', () => {
  assert.equal(isReadOnlyTool('read_file'), true);
  assert.equal(isReadOnlyTool('todo_write'), true);
  assert.deepEqual(planToolBatches([call('mystery_tool')]), [{ mode: 'serial', indexes: [0] }]);
  assert.deepEqual(
    planToolBatches([call('mystery_tool')], { isParallelSafe: () => true }),
    [{ mode: 'parallel', indexes: [0] }],
  );
});

// ─── permission rules ───

test('permission rule parsing accepts every documented shape', () => {
  assert.deepEqual(splitRule('bash'), { tool: 'bash' });
  assert.deepEqual(splitRule('bash(git status *)'), { tool: 'bash', argument: 'git status *' });
  assert.equal(splitRule('unterminated('), null);
});

test('deny beats ask beats allow, regardless of declaration order', () => {
  const rules = parseRuleSet({
    allow: ['bash(git status *)'],
    ask: ['bash(git *)'],
    deny: ['bash(git push --force*)'],
  });
  // Precedence is by bucket, not by specificity: a matching ask rule outranks
  // an allow rule, which is the safe reading of "deny > ask > allow".
  assert.equal(evaluatePermission(rules, { tool: 'bash', args: { command: 'git status --short' } }).decision, 'ask');
  assert.equal(evaluatePermission(rules, { tool: 'bash', args: { command: 'git commit -m x' } }).decision, 'ask');
  assert.equal(
    evaluatePermission(parseRuleSet({ allow: ['bash(git status *)'] }), { tool: 'bash', args: { command: 'git status --short' } }).decision,
    'allow',
  );
  const denied = evaluatePermission(rules, { tool: 'bash', args: { command: 'git push --force origin main' } });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.rule, 'bash(git push --force*)');
});

test('path rules resolve relative to the project and never match outside it', () => {
  const rules = parseRuleSet({ deny: ['write_file(secrets/**)'] });
  const cwd = '/tmp/project';
  assert.equal(evaluatePermission(rules, { tool: 'write_file', args: { file_path: 'secrets/key.txt' }, cwd }).decision, 'deny');
  assert.equal(evaluatePermission(rules, { tool: 'write_file', args: { file_path: './secrets/a/b.pem' }, cwd }).decision, 'deny');
  assert.equal(evaluatePermission(rules, { tool: 'write_file', args: { file_path: 'src/app.ts' }, cwd }).decision, 'ask');
});

test('domain rules match the host, not the path', () => {
  const rules = parseRuleSet({ deny: ['webfetch(domain:*.internal)'] });
  assert.equal(evaluatePermission(rules, { tool: 'webfetch', args: { url: 'https://api.internal/x' } }).decision, 'deny');
  assert.equal(evaluatePermission(rules, { tool: 'webfetch', args: { url: 'https://docs.rs/x' } }).decision, 'ask');
});

test('a malformed rule is reported and dropped instead of crashing evaluation', () => {
  const parsed = parseRule('bash(unclosed');
  assert.ok('error' in parsed);
  assert.match((parsed as any).error, /invalid permission rule/);

  const set = parseRuleSet({ deny: ['bash(unclosed'], allow: ['read_file'] });
  assert.equal(set.deny.length, 0);
  assert.equal(set.errors.length, 1);
  assert.equal(evaluatePermission(set, { tool: 'read_file', args: { file_path: 'a.ts' } }).decision, 'allow');
  assert.equal(evaluatePermission(set, { tool: 'bash', args: { command: 'x' } }).decision, 'ask');

  const merged = mergeRuleSets(set, parseRuleSet({ ask: [] }));
  assert.equal(merged.errors.length, 1, 'errors survive a merge');
});

// ─── read state ───

test('read state remembers reads, distinguishes writes and clears', () => {
  resetReadStateForTests();
  const stat = { mtimeMs: 1000, size: 12 };
  const session = 's1';
  assert.equal(wasFileRead(session, '/a/b.ts'), false);

  recordFileRead(session, '/a/b.ts', stat, 'one\ntwo\n');
  assert.equal(wasFileRead(session, '/a/b.ts'), true);
  assert.equal(isFileUnchangedSinceRead(session, '/a/b.ts', stat), true);
  assert.equal(isFileUnchangedSinceRead(session, '/a/b.ts', { mtimeMs: 1000, size: 13 }), false);

  const record = readRecordFor(session, '/a/b.ts');
  assert.ok(record);
  assert.match(unchangedReadStub('/a/b.ts', record!), /already in this conversation/);

  recordFileWrite(session, '/a/c.ts', stat, 'x');
  assert.equal(wasFileRead(session, '/a/c.ts'), false, 'a write is not a read');

  clearReadState(session);
  assert.equal(wasFileRead(session, '/a/b.ts'), false);
});

// ─── tool result budget ───

test('small tool results pass through untouched', async () => {
  const result = await applyToolResultBudget('short output', { maxInlineChars: 100 });
  assert.equal(result.spilled, false);
  assert.equal(result.content, 'short output');
});

test('large tool results spill to disk with a preview and a path', async () => {
  await withSandbox(async (dir) => {
    const big = `start\n${'x'.repeat(5_000)}\nERROR at the end\n`;
    const result = await applyToolResultBudget(big, { maxInlineChars: 500, previewChars: 200 });
    assert.equal(result.spilled, true);
    assert.ok(result.path, 'spill path is reported');
    assert.ok(result.path!.startsWith(dir), 'spill stays inside the data dir');
    assert.match(result.content, /full output saved/);
    assert.ok(result.content.length < big.length, 'preview is smaller than the original');
    assert.equal(await fs.readFile(result.path!, 'utf8'), big);

    const removed = await pruneSpillFiles(-1);
    assert.ok(removed >= 1, 'pruning removes stale spill files');
  });
});

test('truncateWithNote reports how much was dropped', () => {
  const text = 'a'.repeat(50);
  const truncated = truncateWithNote(text, 20);
  assert.ok(truncated.length <= 200);
  assert.match(truncated, /truncated 30 characters/);
});

// ─── hooks ───

test('hook config parses flat and nested forms and rejects unknown events', () => {
  const flat = parseHookConfig({ PreToolUse: ['echo hi'], Bogus: [] }, 'f.json');
  assert.equal(flat.hooks.length, 1);
  assert.equal(flat.hooks[0].event, 'PreToolUse');
  assert.match(flat.errors.join(' '), /unknown hook event "Bogus"/);

  const nested = parseHookConfig({
    hooks: {
      PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'fmt' }] }],
    },
  }, 'n.json');
  assert.equal(nested.hooks.length, 1);
  assert.equal(nested.hooks[0].matcher, 'write_file');
  assert.equal(nested.hooks[0].command, 'fmt');
});

test('project hooks are not loaded from an untrusted project', async () => {
  await withSandbox(async (dir) => {
    const project = path.join(dir, 'repo');
    await fs.mkdir(path.join(project, '.bitacode'), { recursive: true });
    await fs.writeFile(path.join(project, '.bitacode', 'hooks.json'), JSON.stringify({ PreToolUse: ['echo x'] }));

    const untrusted = loadHooks({ cwd: project, trusted: false });
    assert.equal(untrusted.hooks.length, 0);
    assert.match(untrusted.errors.join(' '), /not trusted/);

    const trusted = loadHooks({ cwd: project, trusted: true });
    assert.equal(trusted.hooks.length, 1);
  });
});

test('a blocking hook stops the call, and a failing hook blocks only blocking events', async () => {
  const blocked = await runHooks({
    event: 'PreToolUse',
    hooks: [{ event: 'PreToolUse', command: 'exit 2', timeoutMs: 5_000, source: 'test' }],
    payload: { event: 'PreToolUse', cwd: process.cwd(), toolName: 'bash' },
    cwd: process.cwd(),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.ran, 1);

  const postFailure = await runHooks({
    event: 'PostToolUse',
    hooks: [{ event: 'PostToolUse', command: 'exit 1', timeoutMs: 5_000, source: 'test' }],
    payload: { event: 'PostToolUse', cwd: process.cwd(), toolName: 'bash' },
    cwd: process.cwd(),
  });
  assert.equal(postFailure.blocked, false);
  assert.equal(postFailure.errors.length, 1);
});

test('a hook that cannot start blocks a blocking event (fail closed)', async () => {
  const outcome = await runHooks({
    event: 'PreToolUse',
    hooks: [{ event: 'PreToolUse', command: 'definitely-not-a-command-xyz', timeoutMs: 3_000, source: 'test' }],
    payload: { event: 'PreToolUse', cwd: process.cwd() },
    cwd: process.cwd(),
  });
  assert.equal(outcome.blocked, true);
});

// ─── project trust ───

test('trust is stored outside the project and can be removed', async () => {
  await withSandbox(async (dir) => {
    const project = path.join(dir, 'repo');
    await fs.mkdir(project, { recursive: true });
    assert.equal(isProjectTrusted(project), false);
    const canonical = trustProject(project);
    assert.equal(isProjectTrusted(project), true);
    assert.deepEqual(listTrustedProjects(), [canonical]);
    assert.equal(untrustProject(project), true);
    assert.equal(isProjectTrusted(project), false);
  });
});

// ─── postcondition verification ───

test('postcondition checks catch missing files, empty output and unapplied edits', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, 'ok.txt');
    await fs.writeFile(file, 'hello world, this is content\n');

    const ok = await verifyToolPostcondition({
      tool: 'write_file',
      args: { file_path: file, content: 'hello world, this is content' },
      result: 'Wrote 1 line',
      cwd: dir,
    });
    assert.equal(ok?.severity, 'ok');

    const missing = await verifyToolPostcondition({
      tool: 'write_file',
      args: { file_path: path.join(dir, 'nope.txt'), content: 'x' },
      result: 'ok',
      cwd: dir,
    });
    assert.equal(missing?.severity, 'fail');

    await fs.writeFile(file, 'const a = 1;\nconst b = 1;\n');
    const wrong = await verifyToolPostcondition({
      tool: 'edit_file',
      args: { file_path: file, old_string: 'const a = 1;', new_string: 'const a = 2;' },
      result: 'Edited',
      cwd: dir,
    });
    assert.equal(wrong?.severity, 'warn');
    assert.match(wrong!.message, /old text is still present/);

    const skipped = await verifyToolPostcondition({ tool: 'read_file', args: {}, result: 'x', cwd: dir });
    assert.equal(skipped, null);
  });
});

// ─── journal + turn manifests ───

test('journal records events, survives a torn line and reports stats', async () => {
  await withSandbox(async () => {
    const id = 'journal-test';
    appendJournal(id, { type: 'session_start' });
    appendJournal(id, { type: 'user', content: 'hello' });
    appendJournal(id, { type: 'tool_call', data: { name: 'read_file' } });
    appendJournal(id, { type: 'tool_result', data: { name: 'read_file', status: 'error' } });
    appendJournal(id, { type: 'assistant', content: 'hi' });
    appendJournal(id, { type: 'compaction', data: { messages: 4 } });

    const journalFile = path.join(process.env.XDG_DATA_HOME!, 'bitacode', 'journal', `${id}.jsonl`);
    await fs.appendFile(journalFile, '{"type":"user","content":"torn');

    const { lines, skipped } = readJournal(id);
    assert.equal(lines.length, 6);
    assert.equal(skipped, 1, 'a torn line is skipped, not fatal');

    const stats = computeJournalStats(id);
    assert.equal(stats.userTurns, 1);
    assert.equal(stats.assistantTurns, 1);
    assert.equal(stats.toolCalls, 1);
    assert.equal(stats.toolErrors, 1);
    assert.equal(stats.compactions, 1);

    assert.match(renderJournalReplay(id).join('\n'), /session journal-test/);
  });
});

test('turn manifests support begin, checkpoint, end and rewind', async () => {
  await withSandbox(async () => {
    const id = 'turns-test';
    beginTurn(id, 0, 'first prompt');
    recordTurnCheckpoint(id, { tool: 'edit_file', ids: ['cp1'], paths: ['a.ts'] });
    endTurn(id);

    beginTurn(id, 5, 'second prompt');
    recordTurnCheckpoint(id, { tool: 'edit_file', ids: ['cp2'], paths: ['b.ts'] });
    endTurn(id);

    const last = resolveRewind(id, 0);
    assert.equal(last?.turn, 2);
    assert.equal(last?.messageIndex, 5);
    assert.deepEqual(checkpointsForRewind(last!), ['cp2']);

    const first = resolveRewind(id, 1);
    assert.equal(first?.turn, 1);
    assert.deepEqual(first?.paths, ['a.ts']);

    truncateTurns(id, 1);
    assert.equal(resolveRewind(id, 0)?.turn, 1);
    assert.equal(resolveRewind(id, 1), null);
  });
});

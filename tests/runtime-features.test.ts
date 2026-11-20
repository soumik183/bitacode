import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  addMemory,
  clearMemory,
  forgetMemory,
  formatMemoryList,
  listMemory,
  memoryFrame,
  readMemoryEntries,
} from '../src/utils/memory.js';
import {
  applyWorkingCheckpoint,
  getWorkingCheckpoint,
  setWorkingCheckpoint,
  workingCheckpointFrame,
  clearWorkingCheckpoint,
  MAX_CHECKPOINT_CHARS,
} from '../src/utils/working-checkpoint.js';
import { collectRepoContext, renderRepoContext, summarizeRepoContext } from '../src/utils/repo-context.js';
import { detectChecks, renderCheckReport, reportPassed, buildFixPrompt } from '../src/utils/autoverify.js';
import {
  expandCommand,
  loadCustomCommands,
  parseCommandFile,
  parseFrontmatter,
  splitCommandArgs,
  type CustomCommand,
} from '../src/utils/custom-commands.js';
import { commonPrefix, completeSlash, completePathToken, completionScript } from '../src/utils/completion.js';
import { HistoryNavigator, appendHistory, loadHistory } from '../src/utils/input-history.js';
import { completeJsonBoundary, isCompleteJson, splitCompleteJsonValues, hasUnterminatedString } from '../src/utils/json-boundary.js';
import { createDecodeSpeedTracker, estimateDecodeTokens, formatTps } from '../src/utils/decode-speed.js';
import { shouldStorePaste, summarizePaste } from '../src/utils/paste.js';
import { applyMention, extractMentions, findMentionToken, listMentionCandidates } from '../src/utils/mentions.js';
import { answerLocally } from '../src/utils/local-answers.js';
import {
  buildLayeredMessages,
  extractCacheUsage,
  formatUsageSummary,
  isVolatileFrame,
  volatileFrame,
} from '../src/utils/context-layers.js';
import { detectTerminalProfile } from '../src/utils/terminal.js';
import { runPermissionsCommand } from '../src/commands/permissions.js';
import { runSessionsCommand } from '../src/commands/sessions.js';
import { collectDoctorReport, renderDoctorReport } from '../src/utils/doctor.js';
import { runHeadless, EXIT_NO_CONFIG } from '../src/headless.js';

async function withSandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-feature2-'));
  const saved = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.HOME = dir;
  process.env.XDG_DATA_HOME = path.join(dir, 'data');
  process.env.XDG_CONFIG_HOME = path.join(dir, 'config');
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
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

// ─── memory ───

test('memory dedupes, filters by kind and forgets by text', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, 'memory.jsonl');
    const first = addMemory({ kind: 'constraint', text: 'never touch migrations', file, source: 'test' });
    assert.ok(!('error' in first));
    const duplicate = addMemory({ kind: 'constraint', text: 'Never touch migrations', file });
    assert.equal(duplicate.id, (first as any).id, 'same text and kind is one entry');

    addMemory({ kind: 'preference', text: 'prefers pnpm', file });
    addMemory({ text: 'plain note', file });

    assert.deepEqual(listMemory({ kind: 'preference' }, file).map((entry) => entry.text), ['prefers pnpm']);
    assert.equal(listMemory({ query: 'pnpm' }, file).length, 1);
    assert.equal(forgetMemory('migrations', file), 1);
    assert.equal(listMemory({}, file).length, 2);

    const { errors } = readMemoryEntries(file);
    assert.deepEqual(errors, []);

    // Constraints are injected before notes.
    const frame = memoryFrame(file);
    assert.match(frame, /^Saved memory/);
    assert.ok(frame.indexOf('[constraint]') < frame.indexOf('[note]'));

    clearMemory(file);
    assert.deepEqual(formatMemoryList(listMemory({}, file)), ['memory is empty']);
  });
});

// ─── working checkpoint ───

test('working checkpoint is capped, framed and clearable', () => {
  clearWorkingCheckpoint('cp-test');
  assert.equal(setWorkingCheckpoint('cp-test', '  step 1 done\nstep 2 next  '), 'step 1 done\nstep 2 next');
  assert.match(workingCheckpointFrame('cp-test'), /Working checkpoint/);

  const long = 'x'.repeat(MAX_CHECKPOINT_CHARS + 500);
  const capped = applyWorkingCheckpoint(long);
  assert.ok(capped.length <= MAX_CHECKPOINT_CHARS);
  assert.match(capped, /truncated/);

  setWorkingCheckpoint('cp-test', '');
  assert.equal(getWorkingCheckpoint('cp-test'), '');
  assert.equal(workingCheckpointFrame('cp-test'), '');
});

// ─── repo context ───

test('repo context renders a snapshot and degrades without git', async () => {
  const plain = await collectRepoContext({
    cwd: os.tmpdir(),
    timeoutMs: 50,
    execFileFn: ((_cmd: string, _args: string[], _options: unknown, cb?: any) => {
      const done = typeof _options === 'function' ? _options : cb;
      setTimeout(() => done?.(Object.assign(new Error('no git'), { code: 1 }), '', ''), 1);
      return {} as any;
    }) as any,
  });
  const rendered = renderRepoContext(plain);
  assert.match(rendered, /Workspace snapshot/);
  assert.match(summarizeRepoContext(plain), /no-git/);
});

test('repo context reads package scripts and reports them', async () => {
  await withSandbox(async (dir) => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node t', lint: 'eslint' } }));
    const context = await collectRepoContext({
      cwd: dir,
      execFileFn: ((_cmd: string, _args: string[], _options: unknown, cb?: any) => {
        const done = typeof _options === 'function' ? _options : cb;
        setTimeout(() => done?.(new Error('no git'), '', ''), 1);
        return {} as any;
      }) as any,
    });
    assert.equal(context.packageName, 'demo');
    assert.deepEqual(Object.keys(context.scripts).sort(), ['lint', 'test']);
    assert.equal(context.notGit, true);
    assert.match(renderRepoContext(context), /scripts: .*test/);
  });
});

// ─── autoverify ───

test('autoverify detects repository checks in priority order', async () => {
  await withSandbox(async (dir) => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { lint: 'eslint .', test: 'node --test', typecheck: 'tsc --noEmit' },
    }));
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');

    const checks = await detectChecks({ cwd: dir });
    assert.deepEqual(checks.map((check) => check.name), ['typecheck', 'lint', 'test']);
    assert.equal(checks[0].command, 'pnpm run typecheck');

    const report = renderCheckReport([
      { name: 'typecheck', command: 'tsc', status: 'pass', exitCode: 0, output: '', durationMs: 1200 },
    ], checks);
    assert.match(report, /Project checks passed/);
    assert.equal(reportPassed([
      { name: 'typecheck', command: 'tsc', status: 'pass', exitCode: 0, output: '', durationMs: 1 },
    ]), true);

    const failed = renderCheckReport([
      { name: 'test', command: 'npm test', status: 'fail', exitCode: 1, output: 'boom', durationMs: 900 },
    ], checks);
    assert.match(failed, /Project checks failed/);
    assert.match(buildFixPrompt([
      { name: 'test', command: 'npm test', status: 'fail', exitCode: 1, output: 'boom', durationMs: 900 },
    ]), /checks failed after your changes/);
  });
});

test('autoverify reports nothing when a repo declares no checks', async () => {
  await withSandbox(async (dir) => {
    const checks = await detectChecks({ cwd: dir });
    assert.deepEqual(checks, []);
    assert.match(renderCheckReport([], checks), /No project checks/);
  });
});

// ─── custom commands ───

test('custom commands parse frontmatter and expand arguments', async () => {
  const parsed = parseCommandFile(
    ['---', 'description: Review a path', 'argument-hint: [path]', '---', 'Review $1 and $2. Args: $ARGUMENTS'].join('\n'),
    '/x/review.md',
  );
  assert.ok(!('error' in parsed));
  const command = parsed as CustomCommand;
  assert.equal(command.name, 'review');
  assert.equal(command.description, 'Review a path');
  assert.equal(command.argumentHint, '[path]');
  assert.equal(expandCommand(command, 'src "a b"'), 'Review src and a b. Args: src "a b"');
  assert.deepEqual(splitCommandArgs('src "a b" c'), ['src', 'a b', 'c']);
  assert.deepEqual(parseFrontmatter('no frontmatter').meta, {});

  await withSandbox(async (dir) => {
    const userDir = path.join(dir, 'commands');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'fix.md'), 'Fix the failing test.');
    const loaded = loadCustomCommands({ cwd: dir, trusted: false, userDir, projectDir: path.join(dir, 'nope') });
    assert.deepEqual(loaded.commands.map((entry) => entry.name), ['fix']);

    const projectDir = path.join(dir, 'proj-commands');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'deploy.md'), 'Deploy.');
    const refused = loadCustomCommands({ cwd: dir, trusted: false, userDir, projectDir });
    assert.equal(refused.commands.length, 1, 'project command ignored when untrusted');
    const allowed = loadCustomCommands({ cwd: dir, trusted: true, userDir, projectDir });
    assert.equal(allowed.commands.length, 2);
  });
});

// ─── completion ───

test('slash completion completes unique names and narrows prefixes', () => {
  assert.equal(commonPrefix(['/model', '/monitor']), '/mo');
  assert.deepEqual(completeSlash('/mem', ['memory', 'model']), { matches: ['/memory'], completion: '/memory ' });
  assert.deepEqual(completeSlash('/mod', ['memory', 'model']), { matches: ['/model'], completion: '/model ' });
  assert.equal(completeSlash('/m', ['memory', 'model']).completion, '/m');
  assert.deepEqual(completeSlash('nope', ['model']), { matches: [] });
  assert.equal(completePathToken(['src/a.ts', 'src/b.ts'], 'src/').completion, 'src/');
  assert.match(completionScript('bash'), /complete -F _bitacode_complete bitacode/);
  assert.match(completionScript('zsh'), /#compdef bitacode/);
  assert.match(completionScript('fish'), /complete -c bitacode/);
});

// ─── input history ───

test('history keeps order, collapses duplicates and restores the draft', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, 'history.jsonl');
    appendHistory('first', { file });
    appendHistory('second', { file });
    appendHistory('second', { file });
    assert.deepEqual(loadHistory(file), ['first', 'second']);

    const nav = new HistoryNavigator(loadHistory(file));
    nav.rememberDraft('draft in progress');
    assert.equal(nav.up(), 'second');
    assert.equal(nav.up(), 'first');
    assert.equal(nav.up(), null, 'stops at the oldest entry');
    assert.equal(nav.down(), 'second');
    assert.equal(nav.down(), 'draft in progress');
    assert.equal(nav.down(), null);
  });
});

// ─── json boundary ───

test('json boundary finds the end of a value with braces inside strings', () => {
  const partial = '{"code":"if (x) { y(); }","n":[1,2';
  assert.equal(completeJsonBoundary(partial), null);
  const complete = '{"code":"if (x) { y(); }","n":[1,2]} extra';
  const end = completeJsonBoundary(complete);
  assert.equal(end, complete.indexOf('} extra') + 1);
  assert.equal(JSON.parse(complete.slice(0, end!)).code, 'if (x) { y(); }');
  assert.equal(isCompleteJson(complete), true);
  assert.equal(isCompleteJson('{"a":'), false);
  assert.equal(hasUnterminatedString('{"a":"unterminated'), true);

  const split = splitCompleteJsonValues('{"a":1}{"b":2}{"c":');
  assert.deepEqual(split.values, ['{"a":1}', '{"b":2}']);
  assert.equal(split.rest, '{"c":');
});

// ─── decode speed ───

test('decode speed estimates tokens and formats a rate', () => {
  assert.equal(estimateDecodeTokens(''), 0);
  assert.ok(estimateDecodeTokens('abcd') === 1);
  assert.equal(formatTps(null), null);
  assert.equal(formatTps(0), null);
  assert.equal(formatTps(42.4), '42 tok/s');
  assert.equal(formatTps(4.2), '4.2 tok/s');

  const tracker = createDecodeSpeedTracker(0);
  const early = tracker.add('hello world', 10);
  assert.equal(early.tps, null, 'no rate before enough elapsed time');
  const later = tracker.add('x'.repeat(400), 2_000);
  assert.ok(later.tps && later.tps > 0);
  assert.match(later.display!, /tok\/s/);
  tracker.correct(100);
  assert.equal(tracker.tokens(), 100);
  tracker.reset(5_000);
  assert.equal(tracker.tokens(), 0);
});

// ─── paste ───

test('large pastes are stored and replaced by a marker', async () => {
  await withSandbox(async () => {
    assert.equal(shouldStorePaste('one line'), false);
    assert.equal(shouldStorePaste('a\nb\nc'), false);
    assert.equal(shouldStorePaste('1\n2\n3\n4\n5\n6\n7\n8'), true);

    const small = await summarizePaste('just text');
    assert.equal(small.stored, false);
    assert.equal(small.text, 'just text');

    const big = await summarizePaste('line\n'.repeat(20), { label: 'session1' });
    assert.equal(big.stored, true);
    assert.ok(big.path);
    assert.match(big.text, /^\[pasted 21 lines/);
    assert.equal((await fs.readFile(big.path!, 'utf8')).split('\n').length, 21);
  });
});

// ─── mentions ───

test('mentions complete paths without leaving the workspace', async () => {
  await withSandbox(async (dir) => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), '');
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });

    const token = findMentionToken('look at @src/ap', 15);
    assert.deepEqual(token, { token: 'src/ap', start: 8, end: 15 });
    assert.equal(findMentionToken('no mention here', 5), null);

    const candidates = await listMentionCandidates(dir, 'src/ap', 5);
    assert.deepEqual(candidates, ['src/app.ts']);
    const atRoot = await listMentionCandidates(dir, '', 10);
    assert.ok(atRoot.includes('src/'));
    assert.ok(!atRoot.some((entry) => entry.startsWith('node_modules')), 'skips noise directories');
    assert.deepEqual(await listMentionCandidates(dir, '../etc', 5), []);

    const applied = applyMention('see @src', { token: 'src', start: 4, end: 8 }, 'src/app.ts');
    assert.deepEqual(applied, { text: 'see @src/app.ts', cursor: 15 });
    assert.deepEqual(extractMentions('@a.ts and @b.ts'), ['a.ts', 'b.ts']);
  });
});

// ─── local answers ───

test('local answers cover runtime facts and stay narrow', () => {
  const context = {
    version: '1.2.3',
    cwd: '/work/repo',
    model: 'gpt-4o',
    provider: 'openrouter',
    approvalMode: 'auto',
    planMode: true,
  };
  assert.equal(answerLocally('/version', context), 'bitacode 1.2.3');
  assert.equal(answerLocally('what version are you?', context), 'bitacode 1.2.3');
  assert.equal(answerLocally('/pwd', context), '/work/repo');
  assert.match(answerLocally('which model is this?', context)!, /gpt-4o via openrouter/);
  assert.match(answerLocally('/mode', context)!, /plan \(read-only\)/);
  assert.equal(answerLocally('fix the failing test', context), null, 'real prompts go to the model');
  assert.equal(answerLocally('', context), null);
});

// ─── context layers ───

test('context layers keep the stable prefix byte-identical across turns', () => {
  const first = buildLayeredMessages({
    system: 'SYSTEM',
    layers: [
      { id: 'repo', stability: 'stable', text: 'branch: main' },
      { id: 'checkpoint', stability: 'volatile', text: 'step 1' },
    ],
    history: [{ role: 'user', content: 'hi' }],
  });
  const second = buildLayeredMessages({
    system: 'SYSTEM',
    layers: [
      { id: 'repo', stability: 'stable', text: 'branch: main' },
      { id: 'checkpoint', stability: 'volatile', text: 'step 2' },
    ],
    history: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(first.stableHash, second.stableHash, 'volatile text does not disturb the cache key');
  assert.equal(first.messages[0].content, 'SYSTEM\n\nbranch: main');
  assert.equal(first.messages[first.messages.length - 1].role, 'system', 'frames sit at the tail');
  assert.equal(isVolatileFrame(first.messages[first.messages.length - 1].content), true);

  const rebuilt = buildLayeredMessages({
    system: 'SYSTEM',
    layers: [{ id: 'checkpoint', stability: 'volatile', text: 'step 3' }],
    history: first.messages,
  });
  const frames = rebuilt.messages.filter((message) => message.role === 'system' && isVolatileFrame(message.content));
  assert.equal(frames.length, 1, 'stale frames are replaced, not appended');

  assert.equal(volatileFrame('x', 'y').startsWith('[runtime-frame:x]'), true);
  assert.equal(formatUsageSummary({ promptTokens: 1200, completionTokens: 40, cachedTokens: 600 }), 'cache 50% · 1.2k in / 40 out');
  assert.equal(formatUsageSummary(undefined), null);
  assert.deepEqual(
    extractCacheUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } }),
    { promptTokens: 10, completionTokens: 2, cachedTokens: 5 },
  );
});

// ─── terminal profile ───

test('terminal profile degrades for dumb terminals and dumb repainters', () => {
  const dumb = detectTerminalProfile({ env: { TERM: 'dumb' } });
  assert.equal(dumb.dumb, true);
  assert.equal(dumb.animations, false);
  assert.equal(dumb.unicode, false);

  const modern = detectTerminalProfile({
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'WezTerm' },
  });
  assert.equal(modern.trueColor, true);
  assert.equal(modern.animations, true);

  const apple = detectTerminalProfile({ env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' } });
  assert.equal(apple.stableRepaints, false, 'Apple Terminal is not safe for fast repaints');
  assert.equal(apple.animations, false);

  const off = detectTerminalProfile({ env: { TERM: 'xterm-256color' }, animationsEnabled: false });
  assert.equal(off.animations, false);
});

// ─── commands ───

test('permissions command shows rules, trusts and untrusts', async () => {
  await withSandbox(async (dir) => {
    const project = path.join(dir, 'repo');
    await fs.mkdir(path.join(project, '.bitacode'), { recursive: true });
    await fs.writeFile(path.join(project, '.bitacode', 'permissions.json'), JSON.stringify({ deny: ['bash(rm -rf *)'] }));

    const lines: string[] = [];
    const write = (line: string) => lines.push(line);

    assert.equal(runPermissionsCommand(['show'], { cwd: project, write }), 0);
    assert.match(lines.join('\n'), /not trusted/);
    assert.match(lines.join('\n'), /ignored/);

    assert.equal(runPermissionsCommand(['trust'], { cwd: project, write }), 0);
    lines.length = 0;
    assert.equal(runPermissionsCommand(['show'], { cwd: project, write }), 0);
    assert.match(lines.join('\n'), /bash\(rm -rf \*\)/);
    assert.match(lines.join('\n'), /trusted/);

    lines.length = 0;
    runPermissionsCommand(['list'], { write });
    assert.match(lines.join('\n'), /repo/);

    assert.equal(runPermissionsCommand(['untrust'], { cwd: project, write }), 0);
    assert.equal(runPermissionsCommand(['show'], { cwd: project, json: true, write }), 0);
    assert.match(lines.join(''), /"trusted":false/);
  });
});

test('sessions command reports empty stores and bad usage without throwing', async () => {
  await withSandbox(async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    await runSessionsCommand(['list'], { write });
    assert.match(lines.join('\n'), /No saved sessions/);

    lines.length = 0;
    await runSessionsCommand(['show'], { write });
    assert.match(lines.join('\n'), /Usage: bitacode sessions show/);

    lines.length = 0;
    await runSessionsCommand(['bogus'], { write });
    assert.match(lines.join('\n'), /Unknown sessions subcommand/);
  });
});

// ─── doctor + headless ───

test('doctor reports the environment offline without leaking secrets', async () => {
  await withSandbox(async () => {
    const report = await collectDoctorReport({ version: '9.9.9' });
    const text = renderDoctorReport(report);
    assert.match(text, /9\.9\.9/);
    assert.match(text, /project trusted/);
    assert.match(text, /logs:/);
    // Never the key itself: the report only states presence.
    assert.match(text, /api key: (present|missing)/);
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(text), 'no credential value leaks into the report');
  });
});

test('headless exits with the no-configuration code instead of hanging', async () => {
  await withSandbox(async (dir) => {
    const out: string[] = [];
    const code = await runHeadless({
      prompt: 'hello',
      json: true,
      cwd: dir,
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
    });
    assert.equal(code, EXIT_NO_CONFIG);
    assert.match(out.join('\n'), /No configuration found/);
  });
});

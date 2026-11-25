/**
 * Tests for the per-task git worktree sandbox utility.
 *
 * Pure tests cover name validation and porcelain parsing. Integration tests
 * build a throwaway git repository (and commit one file) only when `git` is on
 * PATH, then clean up their temp directories. No network access is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  worktreeHome,
} from '../src/utils/worktree.js';

const execFileAsync = promisify(execFile);

let gitAvailable = false;
try {
  await execFileAsync('git', ['--version']);
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const integration = { skip: gitAvailable ? false : 'git is not available' };

interface Fixture {
  repo: string;
  outside: string;
}

async function makeFixture(): Promise<Fixture> {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-wt-outside-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-wt-repo-'));
  await execFileAsync('git', ['init', '-q'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'README.md'), 'hello\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  return { repo, outside };
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await fs.rm(fixture.repo, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(fixture.outside, { recursive: true, force: true }).catch(() => undefined);
}

test('worktreeHome resolves the sandbox directory', () => {
  assert.equal(worktreeHome('/tmp/project'), path.join('/tmp/project', '.bitacode', 'worktrees'));
  assert.equal(worktreeHome(), path.join(process.cwd(), '.bitacode', 'worktrees'));
});

test('worktree names are validated before any filesystem or git access', async () => {
  const cwd = path.join(os.tmpdir(), 'bitacode-wt-does-not-exist');
  const invalid = [
    '',
    '.',
    '..',
    'a/b',
    '../escape',
    '/absolute',
    'C:\\windows',
    'CON',
    'a..b',
    'trailing.',
    'locked.lock',
    'x'.repeat(61),
    'has space',
  ];

  for (const name of invalid) {
    const result = await createWorktree(name, { cwd });
    assert.equal(result.ok, false, `expected "${name}" to be rejected`);
    if (!result.ok) assert.match(result.error, /invalid/i);
  }
  assert.ok(false === (await removeWorktree('..', { cwd })).ok);
});

test('parseWorktreeList extracts only our worktrees and tolerates odd fields', () => {
  const output = [
    'worktree /repo',
    'HEAD abc1234',
    'branch refs/heads/main',
    '',
    'worktree /repo/.bitacode/worktrees/alpha',
    'HEAD abc1234',
    'branch refs/heads/bitacode/alpha',
    'locked keep',
    'unknown-field value',
    '',
    'worktree /repo/.bitacode/worktrees/detached',
    'HEAD def5678',
    'detached',
    '',
    'worktree /repo/.bitacode/worktrees/bad..name',
    'HEAD deadbeef',
    'branch refs/heads/bitacode/bad..name',
    '',
    'worktree /elsewhere/other',
    'HEAD 1234567',
    'branch refs/heads/topic',
    '',
  ].join('\n');

  const parsed = parseWorktreeList(output);
  assert.deepEqual(parsed.map((entry) => entry.name), ['alpha', 'detached']);
  assert.equal(parsed[0].path, '/repo/.bitacode/worktrees/alpha');
  assert.equal(parsed[0].branch, 'bitacode/alpha');
  assert.equal(parsed[0].createdAt, '');
  assert.equal(parsed[1].branch, '');

  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList('HEAD abc1234\nbranch refs/heads/main\n'), []);
  assert.deepEqual(parseWorktreeList('worktree /x\nHEAD abc1234\n'), []);
});

test('parseWorktreeList handles CRLF and Windows-style separators', () => {
  const output = 'worktree C:/repo/.bitacode/worktrees/win\r\n'
    + 'HEAD abc1234\r\n'
    + 'branch refs/heads/bitacode/win\r\n'
    + 'prunable gitdir file points to non-existent location\r\n';
  const parsed = parseWorktreeList(output);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'win');
  assert.equal(parsed[0].branch, 'bitacode/win');
});

test('create, list and remove a worktree round-trip', integration, async () => {
  const fixture = await makeFixture();
  try {
    const created = await createWorktree('alpha', { cwd: fixture.repo });
    assert.equal(created.ok, true, created.ok ? '' : created.error);
    if (!created.ok) return;

    assert.equal(created.value.name, 'alpha');
    assert.equal(created.value.branch, 'bitacode/alpha');
    assert.equal(created.value.path, path.join(worktreeHome(fixture.repo), 'alpha'));
    assert.ok(created.value.createdAt);
    assert.equal(await fs.readFile(path.join(created.value.path, 'README.md'), 'utf8'), 'hello\n');

    const listed = await listWorktrees(fixture.repo);
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    if (!listed.ok) return;
    const found = listed.value.find((entry) => entry.name === 'alpha');
    assert.ok(found, 'created worktree should appear in the list');
    assert.equal(found?.branch, 'bitacode/alpha');
    assert.ok(found?.createdAt);

    const removed = await removeWorktree('alpha', { cwd: fixture.repo });
    assert.equal(removed.ok, true, removed.ok ? '' : removed.error);

    let stillThere = true;
    try {
      await fs.stat(path.join(worktreeHome(fixture.repo), 'alpha'));
    } catch {
      stillThere = false;
    }
    assert.equal(stillThere, false, 'worktree directory should be gone');

    const branches = await execFileAsync('git', ['branch', '--list', 'bitacode/alpha'], { cwd: fixture.repo });
    assert.equal(branches.stdout.trim(), '', 'dedicated branch should be deleted');

    const after = await listWorktrees(fixture.repo);
    assert.ok(after.ok && after.value.length === 0);
  } finally {
    await removeFixture(fixture);
  }
});

test('createWorktree reuses an existing bitacode branch', integration, async () => {
  const fixture = await makeFixture();
  try {
    await execFileAsync('git', ['branch', 'bitacode/beta'], { cwd: fixture.repo });
    const created = await createWorktree('beta', { cwd: fixture.repo });
    assert.equal(created.ok, true, created.ok ? '' : created.error);
    if (!created.ok) return;
    assert.equal(created.value.branch, 'bitacode/beta');
    assert.equal(await fs.readFile(path.join(created.value.path, 'README.md'), 'utf8'), 'hello\n');

    const removed = await removeWorktree('beta', { cwd: fixture.repo });
    assert.equal(removed.ok, true, removed.ok ? '' : removed.error);
  } finally {
    await removeFixture(fixture);
  }
});

test('createWorktree honours an explicit baseRef', integration, async () => {
  const fixture = await makeFixture();
  try {
    await execFileAsync('git', ['checkout', '-q', '-b', 'base'], { cwd: fixture.repo });
    await fs.writeFile(path.join(fixture.repo, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: fixture.repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: fixture.repo });

    const created = await createWorktree('gamma', { cwd: fixture.repo, baseRef: 'base' });
    assert.equal(created.ok, true, created.ok ? '' : created.error);
    if (!created.ok) return;
    assert.equal(await fs.readFile(path.join(created.value.path, 'base.txt'), 'utf8'), 'base\n');
  } finally {
    await removeFixture(fixture);
  }
});

test('removeWorktree reports unknown names and git rejects non-repositories', integration, async () => {
  const fixture = await makeFixture();
  try {
    const missing = await removeWorktree('nope', { cwd: fixture.repo });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /unknown/i);

    const notRepo = await createWorktree('x', { cwd: fixture.outside });
    assert.equal(notRepo.ok, false);
    if (!notRepo.ok) assert.match(notRepo.error, /git/i);
  } finally {
    await removeFixture(fixture);
  }
});

test('createWorktree refuses a worktree parent symlinked outside the repo', integration, async () => {
  if (process.platform === 'win32') return; // symlinks need elevated privileges on Windows
  const fixture = await makeFixture();
  try {
    await fs.symlink(fixture.outside, path.join(fixture.repo, '.bitacode'), 'dir');
    const result = await createWorktree('escape', { cwd: fixture.repo });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /escape|symlink/i);
  } finally {
    await removeFixture(fixture);
  }
});

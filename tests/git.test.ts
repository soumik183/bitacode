import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitStatus, gitDiff, gitAdd, gitCommit, gitStash } from '../src/tools/git.js';
import { setApprovalHandler } from '../src/utils/approval.js';

const execFileAsync = promisify(execFile);
setApprovalHandler(async () => 'approve_once');

const TEMP_REPO = path.join(process.cwd(), 'tests', 'tmp-git-repo');
let originalCwd: string | undefined;

async function setupRepo(): Promise<void> {
  await fs.rm(TEMP_REPO, { recursive: true, force: true });
  await fs.mkdir(TEMP_REPO, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: TEMP_REPO });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: TEMP_REPO });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: TEMP_REPO });
  originalCwd = process.cwd();
  process.chdir(TEMP_REPO);
}

function restoreCwd(): void {
  if (originalCwd) {
    process.chdir(originalCwd);
    originalCwd = undefined;
  }
}

async function cleanup(): Promise<void> {
  restoreCwd();
  await fs.rm(TEMP_REPO, { recursive: true, force: true });
}

test('git status/diff/add/commit work against an isolated repo', async () => {
  await setupRepo();
  try {
    await fs.writeFile(path.join(TEMP_REPO, 'a.txt'), 'one\n', 'utf8');

    let result = await gitStatus(true);
    assert.match(result, /\$ git status --short/);
    assert.match(result, /a\.txt/);

    result = await gitAdd(['a.txt']);
    assert.match(result, /\$ git add a\.txt/);

    result = await gitStatus(true);
    assert.match(result, /A\s+a\.txt/);

    result = await gitDiff(true, true);
    assert.match(result, /\$ git diff --cached --stat/);
    assert.match(result, /a\.txt/);

    result = await gitCommit('init');
    assert.match(result, /\$ git commit -m init/);
    assert.match(result, /1 file changed/);

    result = await gitStatus(true);
    assert.doesNotMatch(result, /a\.txt/);
  } finally {
    await cleanup();
  }
});

test('git stash push and pop round-trip a change', async () => {
  await setupRepo();
  try {
    await fs.writeFile(path.join(TEMP_REPO, 'a.txt'), 'one\n', 'utf8');
    await gitAdd(['a.txt']);
    await gitCommit('init');
    await fs.writeFile(path.join(TEMP_REPO, 'a.txt'), 'two\n', 'utf8');

    let result = await gitStash('push', 'wip');
    assert.match(result, /\$ git stash push -m wip/);
    assert.equal(await fs.readFile(path.join(TEMP_REPO, 'a.txt'), 'utf8'), 'one\n');

    result = await gitStash('pop');
    assert.match(result, /\$ git stash pop/);
    assert.equal(await fs.readFile(path.join(TEMP_REPO, 'a.txt'), 'utf8'), 'two\n');
  } finally {
    await cleanup();
  }
});

test('git tools reject invalid arguments before invoking git', async () => {
  assert.match(await gitAdd(['-f']), /invalid path/i);
  assert.match(await gitAdd([]), /paths is required/i);
  assert.match(await gitCommit(''), /commit message is required/i);
  assert.match(await gitStash('delete-everything'), /invalid stash action/i);
});

test('mutating git tools require approval while read-only ones do not', async () => {
  await setupRepo();
  setApprovalHandler(async () => 'reject');
  try {
    await fs.writeFile(path.join(TEMP_REPO, 'a.txt'), 'one\n', 'utf8');

    assert.match(await gitStatus(true), /a\.txt/);
    assert.match(await gitAdd(['a.txt']), /cancelled by user/i);
    assert.match(await gitStatus(true), /\?\? a\.txt/);
  } finally {
    setApprovalHandler(async () => 'approve_once');
    await cleanup();
  }
});

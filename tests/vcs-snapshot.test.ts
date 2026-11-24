/**
 * Tests for the opt-in git-native snapshot helper.
 *
 * Pure cases cover the id grammar and the "no git / no repo" no-ops. The
 * integration case drives a throwaway git repository created under os.tmpdir()
 * and is skipped entirely when the `git` binary is unavailable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSnapshot,
  deleteSnapshot,
  isGitRepo,
  isValidSnapshotId,
  listSnapshots,
  makeSnapshotId,
  restoreSnapshot,
} from '../src/utils/vcs-snapshot.js';

const execFileAsync = promisify(execFile);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = await gitAvailable();
const ID_PATTERN = /^[A-Za-z0-9._-]{1,60}$/;

async function makeNonRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vcs-snapshot-nonrepo-'));
}

// ---------------------------------------------------------------------------
// Pure validation / id tests (no git repository required)
// ---------------------------------------------------------------------------

test('isValidSnapshotId enforces the documented slug grammar', () => {
  assert.equal(isValidSnapshotId('turn-1'), true);
  assert.equal(isValidSnapshotId('a.b_c-d.E'), true);
  assert.equal(isValidSnapshotId('x'.repeat(60)), true);

  assert.equal(isValidSnapshotId(''), false);
  assert.equal(isValidSnapshotId('x'.repeat(61)), false);
  assert.equal(isValidSnapshotId('bad/id'), false);
  assert.equal(isValidSnapshotId('../escape'), false);
  assert.equal(isValidSnapshotId('with space'), false);
  assert.equal(isValidSnapshotId('.hidden'), false);
  assert.equal(isValidSnapshotId('file.lock'), false);
  assert.equal(isValidSnapshotId(undefined), false);
  assert.equal(isValidSnapshotId(42), false);
});

test('makeSnapshotId always produces a unique, valid, bounded id', () => {
  const ids = new Set<string>();
  for (let index = 0; index < 200; index++) {
    const id = makeSnapshotId('fix/feature #42', 1_760_000_000_000 + index, index / 200);
    assert.match(id, ID_PATTERN);
    assert.ok(id.length <= 60);
    assert.ok(id.startsWith('fix-feature-42-'), id);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
  assert.match(makeSnapshotId('', 0, 0), ID_PATTERN);
  assert.ok(makeSnapshotId('', 0, 0).startsWith('snapshot-'));
});

test('invalid ids are rejected before touching git', async () => {
  for (const bad of ['', '../escape', 'a/b', 'x'.repeat(61), '.']) {
    const restored = await restoreSnapshot(bad, { dryRun: false });
    assert.equal(restored.ok, false, bad);
    if (!restored.ok) assert.match(restored.error, /invalid snapshot id/i);

    const deleted = await deleteSnapshot(bad);
    assert.equal(deleted.ok, false, bad);
    if (!deleted.ok) assert.match(deleted.error, /invalid snapshot id/i);
  }
});

test('outside a git repo every helper is a safe no-op', async () => {
  const dir = await makeNonRepo();
  try {
    assert.equal(await isGitRepo(dir), false);

    const created = await createSnapshot('noop', { cwd: dir });
    assert.equal(created.ok, false);
    if (!created.ok) assert.match(created.error, /not a git repository/i);

    const listed = await listSnapshots({ cwd: dir });
    assert.equal(listed.ok, false);
    if (!listed.ok) assert.match(listed.error, /not a git repository/i);

    const restored = await restoreSnapshot('turn-1', { cwd: dir, dryRun: false });
    assert.equal(restored.ok, false);
    if (!restored.ok) assert.match(restored.error, /not a git repository/i);

    const deleted = await deleteSnapshot('turn-1', { cwd: dir });
    assert.equal(deleted.ok, false);
    if (!deleted.ok) assert.match(deleted.error, /not a git repository/i);

    // Nothing was created in the non-repo directory.
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: real git repository in a throwaway directory
// ---------------------------------------------------------------------------

test('git integration: create/list/restore/delete without touching user work', { skip: !HAS_GIT }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcs-snapshot-repo-'));
  const file = path.join(root, 'file.txt');
  const run = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('git', args, { cwd: root }) as Promise<{ stdout: string; stderr: string }>;
  const porcelain = async (): Promise<string> => (await run(['status', '--porcelain'])).stdout.trim();

  try {
    await run(['init', '-q']);
    await run(['config', 'user.name', 'Snapshot Tests']);
    await run(['config', 'user.email', 'snapshot@example.com']);
    await fs.writeFile(file, 'original\n', 'utf8');
    await run(['add', 'file.txt']);
    await run(['commit', '-q', '-m', 'init']);

    assert.equal(await isGitRepo(root), true);

    // A modified tracked file is the state we want to capture.
    await fs.writeFile(file, 'modified\n', 'utf8');
    const created = await createSnapshot('turn/1: fix bug', { cwd: root });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const snapshot = created.value;

    assert.match(snapshot.id, ID_PATTERN);
    assert.ok(snapshot.id.length <= 60);
    assert.ok(snapshot.id.startsWith('turn-1-fix-bug-'));
    assert.equal(snapshot.ref, `refs/bitacode/snapshots/${snapshot.id}`);
    assert.ok(!Number.isNaN(Date.parse(snapshot.createdAt)));
    assert.ok(snapshot.files.includes('file.txt'));

    // The working tree, index, HEAD and stash list are all untouched.
    assert.equal(await fs.readFile(file, 'utf8'), 'modified\n');
    assert.match(await porcelain(), /^M file\.txt$/);
    assert.equal((await run(['log', '-1', '--format=%s'])).stdout.trim(), 'init');
    assert.equal((await run(['stash', 'list'])).stdout.trim(), '');

    const listed = await listSnapshots({ cwd: root });
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.value.length, 1);
      assert.equal(listed.value[0]?.id, snapshot.id);
      assert.equal(listed.value[0]?.ref, snapshot.ref);
      assert.deepEqual(listed.value[0]?.files, snapshot.files);
    }

    // Default restore is a dry run: it explains but performs nothing.
    const dryRun = await restoreSnapshot(snapshot.id, { cwd: root });
    assert.equal(dryRun.ok, false);
    if (!dryRun.ok) {
      assert.match(dryRun.error, /dry-run/i);
      assert.match(dryRun.error, /git stash apply refs\/bitacode\/snapshots\//);
    }
    assert.equal(await fs.readFile(file, 'utf8'), 'modified\n');

    // A dirty tree is refused outright, even with dryRun: false.
    const dirty = await restoreSnapshot(snapshot.id, { cwd: root, dryRun: false });
    assert.equal(dirty.ok, false);
    if (!dirty.ok) assert.match(dirty.error, /dirty/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'modified\n');

    // Clean the tree, then actually apply the snapshot.
    await run(['restore', '--', 'file.txt']);
    assert.equal(await porcelain(), '');
    const applied = await restoreSnapshot(snapshot.id, { cwd: root, dryRun: false });
    assert.equal(applied.ok, true);
    if (!applied.ok) assert.fail(applied.error);
    assert.equal(await fs.readFile(file, 'utf8'), 'modified\n');

    // Unknown ids are errors, not silent successes.
    const unknown = await restoreSnapshot('missing-0000', { cwd: root, dryRun: false });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error, /unknown snapshot/i);
    const unknownDelete = await deleteSnapshot('missing-0000', { cwd: root });
    assert.equal(unknownDelete.ok, false);
    if (!unknownDelete.ok) assert.match(unknownDelete.error, /unknown snapshot/i);

    // A clean tree uses the commit-tree fallback and a restore-source dry run.
    await run(['restore', '--', 'file.txt']);
    assert.equal(await porcelain(), '');
    const clean = await createSnapshot('clean tree', { cwd: root });
    assert.equal(clean.ok, true);
    if (!clean.ok) return;
    assert.match(clean.value.id, ID_PATTERN);
    assert.deepEqual(clean.value.files, []);
    const cleanDryRun = await restoreSnapshot(clean.value.id, { cwd: root });
    assert.equal(cleanDryRun.ok, false);
    if (!cleanDryRun.ok) {
      assert.match(cleanDryRun.error, /dry-run/i);
      assert.match(cleanDryRun.error, /git restore --source refs\/bitacode\/snapshots\//);
    }
    const cleanApplied = await restoreSnapshot(clean.value.id, { cwd: root, dryRun: false });
    assert.equal(cleanApplied.ok, true);
    if (!cleanApplied.ok) assert.fail(cleanApplied.error);
    assert.equal(await porcelain(), '');

    const withClean = await listSnapshots({ cwd: root });
    assert.equal(withClean.ok, true);
    if (withClean.ok) assert.equal(withClean.value.length, 2);

    // Deletion removes only the addressed ref.
    const deleted = await deleteSnapshot(snapshot.id, { cwd: root });
    assert.equal(deleted.ok, true);
    if (!deleted.ok) assert.fail(deleted.error);
    const deletedClean = await deleteSnapshot(clean.value.id, { cwd: root });
    assert.equal(deletedClean.ok, true);
    if (!deletedClean.ok) assert.fail(deletedClean.error);

    const afterDelete = await listSnapshots({ cwd: root });
    assert.equal(afterDelete.ok, true);
    if (afterDelete.ok) assert.deepEqual(afterDelete.value, []);
    const refs = (await run(['for-each-ref', '--format=%(refname)', 'refs/bitacode/snapshots'])).stdout.trim();
    assert.equal(refs, '');
    assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

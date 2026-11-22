import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch } from '../src/tools/apply-patch.js';
import { setApprovalHandler } from '../src/utils/approval.js';
import { parseFileMutationDiff } from '../src/utils/file-diff.js';

setApprovalHandler(async () => 'approve_once');

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'tmp-apply-patch');

async function setup(): Promise<void> {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
}

test('applyPatch applies multiple hunks in one file', async () => {
  await setup();
  const file = path.join(FIXTURE_DIR, 'multi.txt');
  await fs.writeFile(file, 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n', 'utf8');

  const patch = [
    '--- a/tests/tmp-apply-patch/multi.txt',
    '+++ b/tests/tmp-apply-patch/multi.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
    '@@ -4,3 +4,3 @@',
    ' delta',
    '-epsilon',
    '+EPSILON',
    ' zeta',
  ].join('\n');

  try {
    const result = await applyPatch(patch);
    assert.match(result, /Applied patch to 1 file\(s\)/);
    assert.match(result, /multi\.txt/);
    assert.match(result, /\+2\/-2/);
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha\nBETA\ngamma\ndelta\nEPSILON\nzeta\n');
  } finally {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('applyPatch applies a patch spanning multiple files', async () => {
  await setup();
  const fileA = path.join(FIXTURE_DIR, 'a.txt');
  const fileB = path.join(FIXTURE_DIR, 'b.txt');
  await fs.writeFile(fileA, 'one\n', 'utf8');
  await fs.writeFile(fileB, 'two\n', 'utf8');

  const patch = [
    '--- a/tests/tmp-apply-patch/a.txt',
    '+++ b/tests/tmp-apply-patch/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- a/tests/tmp-apply-patch/b.txt',
    '+++ b/tests/tmp-apply-patch/b.txt',
    '@@ -1 +1 @@',
    '-two',
    '+TWO',
  ].join('\n');

  try {
    const result = await applyPatch(patch);
    assert.match(result, /Applied patch to 2 file\(s\)/);
    assert.equal(await fs.readFile(fileA, 'utf8'), 'ONE\n');
    assert.equal(await fs.readFile(fileB, 'utf8'), 'TWO\n');
  } finally {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('applyPatch result carries a parseable multi-file diff', async () => {
  await setup();
  const fileA = path.join(FIXTURE_DIR, 'one.txt');
  const fileB = path.join(FIXTURE_DIR, 'two.txt');
  await fs.writeFile(fileA, 'one\n', 'utf8');
  await fs.writeFile(fileB, 'two\n', 'utf8');

  const patch = [
    '--- a/tests/tmp-apply-patch/one.txt',
    '+++ b/tests/tmp-apply-patch/one.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '--- a/tests/tmp-apply-patch/two.txt',
    '+++ b/tests/tmp-apply-patch/two.txt',
    '@@ -1 +1 @@',
    '-two',
    '+TWO',
  ].join('\n');

  try {
    const result = await applyPatch(patch);
    assert.match(result, /Applied patch to 2 file\(s\)/);
    assert.match(result, /\+1\/-1/);

    const parsed = parseFileMutationDiff('apply_patch', '{}', result)!;
    assert.ok(parsed);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0]!.filePath, 'tests/tmp-apply-patch/one.txt');
    assert.equal(parsed.entries[1]!.filePath, 'tests/tmp-apply-patch/two.txt');
    assert.match(parsed.entries[0]!.diff, /\+ONE/);
    assert.match(parsed.entries[1]!.diff, /\+TWO/);
  } finally {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('applyPatch rejects a conflicting patch without writing any file', async () => {
  await setup();
  const conflict = path.join(FIXTURE_DIR, 'conflict.txt');
  const good = path.join(FIXTURE_DIR, 'good.txt');
  await fs.writeFile(conflict, 'alpha\nbeta\n', 'utf8');
  await fs.writeFile(good, 'alpha\nbeta\n', 'utf8');

  const patch = [
    '--- a/tests/tmp-apply-patch/conflict.txt',
    '+++ b/tests/tmp-apply-patch/conflict.txt',
    '@@ -1,2 +1,2 @@',
    ' alpha',
    '-WRONG',
    '+RIGHT',
    '--- a/tests/tmp-apply-patch/good.txt',
    '+++ b/tests/tmp-apply-patch/good.txt',
    '@@ -1,2 +1,2 @@',
    ' alpha',
    '-beta',
    '+BETA',
  ].join('\n');

  try {
    const result = await applyPatch(patch);
    assert.match(result, /does not apply cleanly|context mismatch/i);
    assert.match(result, /No files were changed/i);
    assert.equal(await fs.readFile(conflict, 'utf8'), 'alpha\nbeta\n');
    assert.equal(await fs.readFile(good, 'utf8'), 'alpha\nbeta\n');
  } finally {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('applyPatch writes nothing when approval is rejected', async () => {
  await setup();
  const file = path.join(FIXTURE_DIR, 'reject.txt');
  await fs.writeFile(file, 'one\n', 'utf8');
  setApprovalHandler(async () => 'reject');

  const patch = [
    '--- a/tests/tmp-apply-patch/reject.txt',
    '+++ b/tests/tmp-apply-patch/reject.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
  ].join('\n');

  try {
    const result = await applyPatch(patch);
    assert.match(result, /cancelled|rejected/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\n');
  } finally {
    setApprovalHandler(async () => 'approve_once');
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('applyPatch rejects paths outside the working directory', async () => {
  await setup();
  const patch = [
    '--- a/../outside.txt',
    '+++ b/../outside.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
  ].join('\n');

  const result = await applyPatch(patch);
  assert.match(result, /outside the working directory/i);
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

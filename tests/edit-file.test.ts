import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { editFile } from '../src/tools/edit-file.js';
import {
  clearApprovalHandler,
  clearSessionApprovals,
  setApprovalHandler,
} from '../src/utils/approval.js';

test.beforeEach(() => {
  setApprovalHandler(async () => 'approve_once');
});

test.afterEach(() => {
  clearApprovalHandler();
  clearSessionApprovals();
});

async function withFixture(content: string, fn: (rel: string, abs: string) => Promise<void>) {
  const dir = path.join(process.cwd(), 'tests', 'tmp-edit-file-tests');
  const abs = path.join(dir, 'fixture.txt');
  const rel = 'tests/tmp-edit-file-tests/fixture.txt';
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  try {
    await fn(rel, abs);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('fuzzy match with two distinct candidate blocks fails instead of editing the wrong one', async () => {
  // Neither block contains old_string verbatim, but both normalize to it.
  // The cascade must report ambiguity rather than silently picking the first.
  const content = [
    'const  x = 1;',
    '// separator',
    'const x  = 1;',
  ].join('\n');

  await withFixture(content, async (rel, abs) => {
    const result = await editFile(rel, 'const x = 1;', 'const x = 2;');

    assert.match(result, /ambiguous/i);
    assert.equal(await fs.readFile(abs, 'utf8'), content, 'file must be unchanged');
  });
});

test('expected_replacements mismatch fails without editing', async () => {
  const content = 'const x = 1;\nconst x = 1;\n';

  await withFixture(content, async (rel, abs) => {
    const result = await editFile(rel, 'const x = 1;', 'const x = 2;', 1);

    assert.match(result, /found 2 occurrence\(s\).*expected 1/s);
    assert.equal(await fs.readFile(abs, 'utf8'), content, 'file must be unchanged');
  });
});

test('normal single replacement applies by index and returns a unified diff', async () => {
  await withFixture('hello world\n', async (rel, abs) => {
    const result = await editFile(rel, 'world', 'there');

    assert.match(result, /Successfully edited/);
    assert.match(result, /1 replacement\(s\) made/);
    assert.match(result, /-hello world/);
    assert.match(result, /\+hello there/);
    assert.equal(await fs.readFile(abs, 'utf8'), 'hello there\n');
  });
});

test('multiple expected replacements are applied by exact index', async () => {
  await withFixture('repeat\nkeep\nrepeat\n', async (rel, abs) => {
    const result = await editFile(rel, 'repeat', 'done', 2);

    assert.match(result, /2 replacement\(s\) made/);
    assert.equal(await fs.readFile(abs, 'utf8'), 'done\nkeep\ndone\n');
  });
});

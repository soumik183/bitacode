import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { multiedit, multieditTool } from '../src/tools/multiedit.js';
import { deletePath, deleteTool } from '../src/tools/delete.js';
import { renamePath, renameTool } from '../src/tools/rename.js';
import { movePath, moveTool } from '../src/tools/move.js';
import { copyPath, copyTool } from '../src/tools/copy.js';
import { makeDirectory, mkdirTool } from '../src/tools/mkdir.js';
import { statPath, statTool } from '../src/tools/stat.js';
import { diffFiles, diffTool } from '../src/tools/diff.js';
import { resetApprovalStateForTests, setApprovalHandler, type ApprovalResponse } from '../src/utils/approval.js';
import { setAllowedPathRoots } from '../src/utils/path-validation.js';

let root: string;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ops-test-'));
  await setAllowedPathRoots([root]);
  resetApprovalStateForTests();
  setApprovalHandler(async () => 'approve_once');
});

test.afterEach(async () => {
  await setAllowedPathRoots([]);
  resetApprovalStateForTests();
  await fs.rm(root, { recursive: true, force: true });
});

const p = (...parts: string[]): string => path.join(root, ...parts);

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

test('tool definitions have the standard function schema', () => {
  const defs = [multieditTool, deleteTool, renameTool, moveTool, copyTool, mkdirTool, statTool, diffTool];
  assert.equal(defs.length, 8);
  for (const def of defs) {
    assert.equal(def.type, 'function');
    assert.equal(typeof def.function.name, 'string');
    assert.ok(def.function.description.length > 0);
    assert.equal(def.function.parameters.type, 'object');
  }
  assert.deepEqual(defs.map((def) => def.function.name), [
    'multiedit', 'delete', 'rename', 'move', 'copy', 'mkdir', 'stat', 'diff',
  ]);
});

test('multiedit applies every edit and returns per-file diffs', async () => {
  const a = p('a.txt');
  const b = p('b.txt');
  await fs.writeFile(a, 'one two\n');
  await fs.writeFile(b, 'three three\n');

  const result = await multiedit([
    { file_path: a, old_string: 'one', new_string: 'ONE' },
    { file_path: b, old_string: 'three', new_string: '3', expected_replacements: 2 },
  ]);

  assert.match(result, /Successfully edited 2 file\(s\)/);
  assert.match(result, /-one two/);
  assert.equal(await fs.readFile(a, 'utf8'), 'ONE two\n');
  assert.equal(await fs.readFile(b, 'utf8'), '3 3\n');
});

test('multiedit validates all edits first: a bad second edit changes nothing', async () => {
  const a = p('a.txt');
  const b = p('b.txt');
  await fs.writeFile(a, 'keep');
  await fs.writeFile(b, 'keep');

  const result = await multiedit([
    { file_path: a, old_string: 'keep', new_string: 'changed' },
    { file_path: b, old_string: 'MISSING', new_string: 'x' },
  ]);

  assert.match(result, /^Error:/);
  assert.match(result, /No files were changed/);
  assert.equal(await fs.readFile(a, 'utf8'), 'keep');
  assert.equal(await fs.readFile(b, 'utf8'), 'keep');
});

test('delete rejects paths outside allowed roots and the project root', async () => {
  const outside = path.join(path.dirname(root), `file-ops-outside-${Date.now()}.txt`);
  await fs.writeFile(outside, 'x');
  try {
    assert.match(await deletePath(outside), /outside the working directory/i);
    assert.ok(await exists(outside), 'outside file must survive');

    const cwdResult = await deletePath(process.cwd());
    assert.match(cwdResult, /^Error:/);
    assert.match(cwdResult, /project root/i);
    assert.ok(await exists(process.cwd()));
  } finally {
    await fs.rm(outside, { force: true });
  }
});

test('delete requires recursive for directories and removes files/dirs otherwise', async () => {
  const dir = p('dir');
  await fs.mkdir(p('dir/sub'), { recursive: true });
  await fs.writeFile(p('dir/sub/f.txt'), 'x');
  assert.match(await deletePath(dir), /recursive/);
  assert.ok(await exists(p('dir/sub/f.txt')));

  assert.match(await deletePath(dir, true), /^Deleted/);
  assert.equal(await exists(dir), false);

  const file = p('one.txt');
  await fs.writeFile(file, 'x');
  assert.match(await deletePath(file), /^Deleted/);
  assert.equal(await exists(file), false);
});

test('rename and move succeed and refuse to overwrite without permission', async () => {
  const source = p('src.txt');
  await fs.writeFile(source, 'data');

  assert.match(await renamePath(source, p('renamed.txt')), /^Renamed/);
  assert.equal(await fs.readFile(p('renamed.txt'), 'utf8'), 'data');

  const nested = p('deep/nested/moved.txt');
  assert.match(await movePath(p('renamed.txt'), nested), /^Moved/);
  assert.equal(await fs.readFile(nested, 'utf8'), 'data');

  const occupied = p('occupied.txt');
  await fs.writeFile(occupied, 'old');
  const guard = await renamePath(nested, occupied);
  assert.match(guard, /already exists/);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'old');

  assert.match(await renamePath(nested, occupied, true), /^Renamed/);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'data');
});

test('copy succeeds for files and directories and guards overwrites', async () => {
  const source = p('src.txt');
  await fs.writeFile(source, 'data');

  assert.match(await copyPath(source, p('copies/clone.txt')), /^Copied/);
  assert.equal(await fs.readFile(p('copies/clone.txt'), 'utf8'), 'data');

  const guarded = await copyPath(source, p('copies/clone.txt'));
  assert.match(guarded, /already exists/);
  assert.match(await copyPath(source, p('copies/clone.txt'), false, true), /^Copied/);

  await fs.mkdir(p('tree/sub'), { recursive: true });
  await fs.writeFile(p('tree/sub/f.txt'), 'nested');
  assert.match(await copyPath(p('tree'), p('tree-copy'), false), /recursive/);
  assert.match(await copyPath(p('tree'), p('tree-copy'), true), /^Copied/);
  assert.equal(await fs.readFile(p('tree-copy/sub/f.txt'), 'utf8'), 'nested');
});

test('mkdir creates nested directories and is idempotent', async () => {
  const nested = p('x/y/z');
  assert.match(await makeDirectory(nested), /Created directory/);
  assert.ok((await fs.stat(nested)).isDirectory());
  assert.match(await makeDirectory(nested), /already exists/);
  assert.match(await makeDirectory(p('missing-parent/child'), false), /^Error:/);
});

test('stat reports human-readable metadata', async () => {
  const file = p('stat.txt');
  await fs.writeFile(file, 'abc');
  const output = await statPath(file);
  assert.match(output, /Path: /);
  assert.match(output, /Type: file/);
  assert.match(output, /Size: 3 B \(3 bytes\)/);
  assert.match(output, /Mode: [0-7]{4}/);
  assert.match(output, /Modified: \d{4}-\d{2}-\d{2}T/);
  assert.match(output, /Symlink: no/);
});

test('diff compares two files and file content with line counts', async () => {
  const a = p('a.txt');
  const b = p('b.txt');
  await fs.writeFile(a, 'one\ntwo\n');
  await fs.writeFile(b, 'one\nthree\n');

  const output = await diffFiles({ file_a: a, file_b: b });
  assert.match(output, /^Comparing/);
  assert.match(output, /2 vs 2 lines/);
  assert.match(output, /-two/);
  assert.match(output, /\+three/);

  assert.match(await diffFiles({ file_path: a, content: 'one\ntwo\n' }), /No differences/);
  assert.match(await diffFiles({ file_path: a, content: 'one\nTWO\n' }), /-two/);
});

test('approval rejection returns a cancellation string and leaves data intact', async () => {
  const file = p('protected.txt');
  await fs.writeFile(file, 'safe');
  const response: ApprovalResponse = 'reject';
  setApprovalHandler(async () => response);

  const deletion = await deletePath(file);
  assert.equal(typeof deletion, 'string');
  assert.match(deletion, /cancel/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'safe');

  const edit = await multiedit([{ file_path: file, old_string: 'safe', new_string: 'gone' }]);
  assert.match(edit, /cancel/i);
  assert.equal(await fs.readFile(file, 'utf8'), 'safe');
});

test('malformed arguments produce error strings, never exceptions', async () => {
  for (const bad of [undefined, null, 42, [], {}, NaN]) {
    const results = await Promise.all([
      multiedit(bad),
      deletePath(bad),
      renamePath(bad, bad),
      movePath(bad, bad),
      copyPath(bad, bad),
      makeDirectory(bad),
      statPath(bad),
      diffFiles(bad),
    ]);
    for (const result of results) {
      assert.equal(typeof result, 'string');
      assert.match(result, /^Error:/, `unexpected result for ${JSON.stringify(bad)}: ${result}`);
    }
  }
});

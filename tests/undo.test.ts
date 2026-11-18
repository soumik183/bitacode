import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, clearCheckpoints } from '../src/utils/checkpoint.js';
import { undo } from '../src/tools/undo.js';

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-undo-home-'));
  const original = process.env.HOME;
  process.env.HOME = home;
  return fn().finally(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test('undo restores the most recent checkpoint and reports it', async () => {
  await withTempHome(async () => {
    const dir = path.join(process.cwd(), 'tests', 'tmp-undo-last');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'file.txt');
    const rel = path.relative(process.cwd(), file);

    try {
      await fsp.writeFile(file, 'v1', 'utf8');
      await createCheckpoint([rel], 'undo-sess-last', 'edit_file');
      await fsp.writeFile(file, 'v2', 'utf8');

      const result = await undo(undefined, 'undo-sess-last');

      assert.match(result, /Undid changes from edit_file/);
      assert.match(result, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await fsp.readFile(file, 'utf8'), 'v1');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await clearCheckpoints('undo-sess-last');
    }
  });
});

test('undo restores a specific checkpoint by id', async () => {
  await withTempHome(async () => {
    const dir = path.join(process.cwd(), 'tests', 'tmp-undo-by-id');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'file.txt');
    const rel = path.relative(process.cwd(), file);

    try {
      await fsp.writeFile(file, 'v1', 'utf8');
      const [id] = await createCheckpoint([rel], 'undo-sess-id', 'edit_file');
      await fsp.writeFile(file, 'v2', 'utf8');

      const result = await undo(id, 'undo-sess-id');

      assert.match(result, /Undid checkpoint/);
      assert.equal(await fsp.readFile(file, 'utf8'), 'v1');
      assert.equal(await undo(id, 'undo-sess-id').then((r) => /No checkpoint with id/.test(r)), true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
      await clearCheckpoints('undo-sess-id');
    }
  });
});

test('undo with no checkpoints returns a clear message', async () => {
  await withTempHome(async () => {
    const result = await undo(undefined, 'undo-sess-empty');
    assert.match(result, /Nothing to undo/i);
  });
});

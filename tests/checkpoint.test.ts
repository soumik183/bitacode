import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearCheckpoints,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from '../src/utils/checkpoint.js';

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-checkpoint-home-'));
  const original = process.env.HOME;
  process.env.HOME = home;
  return fn().finally(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

async function fixtureDir(name: string): Promise<string> {
  const dir = path.join(process.cwd(), 'tests', name);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('createCheckpoint snapshots content and metadata, and listCheckpoints reads it back', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-core');
    try {
      const file = path.join(dir, 'a.txt');
      await fsp.writeFile(file, 'original', 'utf8');
      const rel = path.relative(process.cwd(), file);

      const ids = await createCheckpoint([rel], 'sess-core', 'edit_file');
      assert.equal(ids.length, 1);

      const list = await listCheckpoints('sess-core');
      assert.equal(list.length, 1);
      assert.equal(list[0].id, ids[0]);
      assert.equal(list[0].path, file, 'checkpoints store an absolute path');
      assert.equal(list[0].content, 'original');
      assert.equal(list[0].tool, 'edit_file');
      assert.ok(!Number.isNaN(Date.parse(list[0].createdAt)));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('restoreCheckpoint writes content back and deletes the checkpoint', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-restore');
    try {
      const file = path.join(dir, 'b.txt');
      await fsp.writeFile(file, 'original', 'utf8');
      const rel = path.relative(process.cwd(), file);
      const [id] = await createCheckpoint([rel], 'sess-restore', 'edit_file');

      await fsp.writeFile(file, 'changed', 'utf8');
      const restored = await restoreCheckpoint(id, 'sess-restore');

      assert.deepEqual(restored, [file], 'restore reports absolute paths');
      assert.equal(await fsp.readFile(file, 'utf8'), 'original');
      assert.deepEqual(await listCheckpoints('sess-restore'), []);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('a checkpoint of a missing file restores by deleting the created file', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-missing');
    try {
      const file = path.join(dir, 'new.txt');
      const rel = path.relative(process.cwd(), file);
      const [id] = await createCheckpoint([rel], 'sess-missing', 'write_file');
      assert.equal((await listCheckpoints('sess-missing'))[0].content, null);

      await fsp.writeFile(file, 'created');
      const restored = await restoreCheckpoint(id, 'sess-missing');

      assert.deepEqual(restored, [file]);
      assert.equal(fs.existsSync(file), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('clearCheckpoints removes every checkpoint for a session', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-clear');
    try {
      const a = path.join(dir, 'a.txt');
      const b = path.join(dir, 'b.txt');
      await fsp.writeFile(a, 'a');
      await fsp.writeFile(b, 'b');
      await createCheckpoint([path.relative(process.cwd(), a)], 'sess-clear', 'edit_file');
      await createCheckpoint([path.relative(process.cwd(), b)], 'sess-clear', 'edit_file');
      assert.equal((await listCheckpoints('sess-clear')).length, 2);

      await clearCheckpoints('sess-clear');
      assert.deepEqual(await listCheckpoints('sess-clear'), []);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('oversized files are skipped', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-large');
    try {
      const file = path.join(dir, 'big.bin');
      const handle = await fsp.open(file, 'w');
      await handle.truncate(2 * 1024 * 1024 + 1);
      await handle.close();

      const ids = await createCheckpoint([path.relative(process.cwd(), file)], 'sess-large', 'write_file');
      assert.deepEqual(ids, []);
      assert.deepEqual(await listCheckpoints('sess-large'), []);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

test('at most 100 checkpoints are kept per session', async () => {
  await withTempHome(async () => {
    const dir = await fixtureDir('tmp-checkpoint-cap');
    try {
      const file = path.join(dir, 'c.txt');
      await fsp.writeFile(file, 'c');
      const rel = path.relative(process.cwd(), file);

      const ids: string[] = [];
      for (let i = 0; i < 101; i++) {
        ids.push(...await createCheckpoint([rel], 'sess-cap', 'edit_file'));
      }
      const list = await listCheckpoints('sess-cap');
      assert.equal(list.length, 100);
      assert.equal(list.some((c) => c.id === ids[0]), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// Regression: a planted checkpoint under the store could write anywhere, and
// relative paths were restored against today's cwd instead of the session's.
test('restoreCheckpoint refuses a checkpoint that points outside the sandbox', async () => {
  await withTempHome(async () => {
    const victim = path.join(path.dirname(process.cwd()), `planted-${process.pid}.txt`);
    try {
      await createCheckpoint(['reports/x.txt'], 'sess-planted', 'write_file');
      const [entry] = await listCheckpoints('sess-planted');
      const dir = path.join(
        process.env.HOME!,
        '.local',
        'share',
        'bitacode',
        'checkpoints',
        'sess-planted'
      );
      // Files are named <timestamp>-<id>.json; find the real one.
      const fileName = fs.readdirSync(dir).find((name) => name.includes(entry.id));
      assert.ok(fileName, 'checkpoint file exists');
      const file = path.join(dir, fileName!);
      await fsp.writeFile(
        file,
        JSON.stringify({ path: victim, content: 'pwned', createdAt: entry.createdAt, tool: 'write_file' }),
        'utf8'
      );

      const restored = await restoreCheckpoint(entry.id, 'sess-planted');
      assert.deepEqual(restored, [], 'nothing may be restored outside the allowed roots');
      assert.equal(fs.existsSync(victim), false, 'the planted path was not written');
    } finally {
      await fsp.rm(victim, { force: true });
    }
  });
});

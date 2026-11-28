import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOutputLastMessage } from '../src/headless.js';

test('writeOutputLastMessage writes the final message with one trailing newline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-lastmsg-'));
  const file = path.join(dir, 'last.txt');
  try {
    await writeOutputLastMessage(file, 'done\n\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'done\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

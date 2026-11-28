import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  setSessionArchived,
} from '../src/sessions.js';

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-archive-'));
  const original = process.env.HOME;
  process.env.HOME = home;
  return fn().finally(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

test('archiving a session persists the flag and delete removes it', async () => {
  await withTempHome(async () => {
    const session = createSession('gpt-test', 'openai');
    session.completionMessages = [{ role: 'user', content: 'hello' } as never];

    await saveSession(session);
    assert.ok((await listSessions()).some((entry) => entry.id === session.id));

    assert.equal(await setSessionArchived(session.id, true), true);
    assert.equal((await loadSession(session.id))?.archived, true);
    assert.equal((await listSessions()).find((entry) => entry.id === session.id)?.archived, true);

    assert.equal(await deleteSession(session.id), true);
    assert.equal(await loadSession(session.id), null);
  });
});

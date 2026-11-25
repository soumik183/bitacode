import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  importSessionFile,
  validateSessionJson,
} from '../src/utils/session-import.js';

let root: string;
let sourceDir: string;
let sessionsDir: string;

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-import-test-'));
  sourceDir = path.join(root, 'source');
  sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sourceDir, { recursive: true });
});

test.afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'abcd1234',
    title: 'Imported session',
    provider: 'openai',
    model: 'gpt-4o',
    completionMessages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  });
}

function sourceFile(text: string, name = 'session.json'): string {
  const file = path.join(sourceDir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function importOptions(extra: Record<string, unknown> = {}): { sessionsDir: string } {
  return { sessionsDir, ...extra };
}

test('validateSessionJson accepts a well-formed session', () => {
  const result = validateSessionJson(sessionJson());
  assert.deepEqual(result, {
    ok: true,
    value: { id: 'abcd1234', title: 'Imported session', messageCount: 1 },
  });
});

test('validateSessionJson accepts a session without optional fields', () => {
  const result = validateSessionJson(JSON.stringify({ completionMessages: [] }));
  assert.deepEqual(result, { ok: true, value: { messageCount: 0 } });
  assert.equal(validateSessionJson(
    JSON.stringify({ id: '01234567-89ab-4cde-8fab-0123456789ab', completionMessages: [] })
  ).ok, true);
});

test('validateSessionJson rejects malformed input and missing completionMessages', () => {
  assert.equal(validateSessionJson('{ nope').ok, false);
  assert.equal(validateSessionJson('null').ok, false);
  assert.equal(validateSessionJson('[]').ok, false);
  assert.equal(validateSessionJson('42').ok, false);
  assert.equal(validateSessionJson(JSON.stringify({ title: 'no messages' })).ok, false);
  assert.equal(validateSessionJson(JSON.stringify({ completionMessages: {} })).ok, false);
  assert.equal(validateSessionJson(null as unknown as string).ok, false);
});

test('validateSessionJson enforces the 100k message cap', () => {
  const messages = Array.from({ length: 100_001 }, () => ({ role: 'user', content: '' }));
  const result = validateSessionJson(JSON.stringify({ completionMessages: messages }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /100000/);
});

test('validateSessionJson enforces the 50MB input cap', () => {
  const oversized = JSON.stringify({ completionMessages: [], padding: 'x'.repeat(50 * 1024 * 1024) });
  const result = validateSessionJson(oversized);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /50MB/);
});

test('validateSessionJson sanitises the title', () => {
  const result = validateSessionJson(sessionJson({
    id: undefined,
    title: '  a\u0000b\nc  '.padEnd(220, 'z'),
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, undefined);
  assert.equal(result.value.title?.length, 200);
  assert.equal(result.value.title?.includes('\n'), false);
});

test('validateSessionJson rejects path traversal ids', () => {
  for (const id of ['../../etc/passwd', '..\\evil', 'a/b', 'good..id']) {
    const result = validateSessionJson(sessionJson({ id }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /path traversal/);
  }
});

test('importSessionFile copies the source into sessionsDir without changing it', () => {
  const source = sourceFile(sessionJson({
    completionMessages: [
      { role: 'user', content: 'hi', reasoning: 'secret', bitacodeMeta: 1 },
    ],
  }));
  const before = fs.readFileSync(source, 'utf8');
  const result = importSessionFile(source, importOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, 'abcd1234');
  assert.equal(result.value.path, path.join(sessionsDir, 'abcd1234.json'));
  assert.equal(fs.readFileSync(source, 'utf8'), before);
  const written = JSON.parse(fs.readFileSync(result.value.path, 'utf8'));
  assert.equal(written.completionMessages[0].content, 'hi');
  assert.equal('reasoning' in written.completionMessages[0], false);
  assert.equal('bitacodeMeta' in written.completionMessages[0], false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.value.path).mode & 0o777, 0o600);
  }
});

test('importSessionFile honours a valid newId', () => {
  const source = sourceFile(sessionJson({ id: 'abcd1234' }));
  const result = importSessionFile(source, importOptions({ newId: 'zz99yy88' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, 'zz99yy88');
  assert.equal(fs.existsSync(path.join(sessionsDir, 'zz99yy88.json')), true);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'abcd1234.json')), false);
});

test('importSessionFile generates an 8-char id for missing or invalid ids', () => {
  for (const [index, overrides] of [
    { id: undefined },
    { id: 'not a valid id' },
  ].entries()) {
    const source = sourceFile(sessionJson(overrides), `source-${index}.json`);
    const result = importSessionFile(source, importOptions());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.id, /^[0-9a-z]{8}$/);
    assert.equal(fs.existsSync(result.value.path), true);
  }
  const invalidNewId = importSessionFile(sourceFile(sessionJson(), 'third.json'), importOptions({
    newId: '../../escape',
  }));
  assert.equal(invalidNewId.ok, true);
  if (!invalidNewId.ok) return;
  assert.match(invalidNewId.value.id, /^[0-9a-z]{8}$/);
});

test('importSessionFile never overwrites an existing session', () => {
  const source = sourceFile(sessionJson({ id: 'abcd1234' }));
  const target = path.join(sessionsDir, 'abcd1234.json');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(target, 'original');
  const result = importSessionFile(source, importOptions());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /already exists/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('importSessionFile requires the source to be a regular file', () => {
  const missing = path.join(sourceDir, 'missing.json');
  assert.equal(importSessionFile(missing, importOptions()).ok, false);
  assert.equal(importSessionFile(sourceDir, importOptions()).ok, false);
  assert.equal(importSessionFile('', importOptions()).ok, false);

  const source = sourceFile(sessionJson());
  const link = path.join(sourceDir, 'link.json');
  try {
    fs.symlinkSync(source, link);
    assert.equal(importSessionFile(link, importOptions()).ok, false);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  }
});

test('importSessionFile rejects an oversized source before reading it', () => {
  const source = path.join(sourceDir, 'huge.json');
  fs.truncateSync(source, 50 * 1024 * 1024 + 1);
  const result = importSessionFile(source, importOptions());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /50MB/);
  assert.deepEqual(fs.readdirSync(sessionsDir), []);
});

test('a traversal id cannot write outside sessionsDir', () => {
  const escapeName = `${path.basename(root)}-escape`;
  const source = sourceFile(sessionJson({ id: `../../${escapeName}` }));
  const result = importSessionFile(source, importOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(path.dirname(result.value.path), path.resolve(sessionsDir));
  assert.equal(fs.existsSync(path.join(root, `${escapeName}.json`)), false);
  assert.equal(fs.existsSync(path.join(root, '..', `${escapeName}.json`)), false);
});

test('importSessionFile caps title and provider/model strings', () => {
  const source = sourceFile(sessionJson({
    title: 't'.repeat(500),
    provider: 'p\u0007rovider',
    model: 'm'.repeat(500),
  }, 'capped.json'));
  const result = importSessionFile(source, importOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const written = JSON.parse(fs.readFileSync(result.value.path, 'utf8'));
  assert.equal(written.title.length, 200);
  assert.equal(written.provider, 'provider');
  assert.equal(written.model.length, 200);
});

test('garbage sources return errors instead of throwing', () => {
  const source = sourceFile('\u0000\u0001 not json');
  const result = importSessionFile(source, importOptions({ newId: 'bad id' }));
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(sessionsDir), []);
});

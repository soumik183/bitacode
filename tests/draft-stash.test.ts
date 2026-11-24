import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteDraft,
  listDrafts,
  popDraft,
  saveDraft,
  stashPath,
  type DraftStash,
} from '../src/utils/draft-stash.js';

let dataDir: string;

test.beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-drafts-test-'));
});

test.afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function rawPath(): string {
  return stashPath({ dataDir });
}

function readRaw(): DraftStash[] {
  return JSON.parse(fs.readFileSync(rawPath(), 'utf8')) as DraftStash[];
}

function writeRaw(value: unknown): void {
  fs.mkdirSync(path.dirname(rawPath()), { recursive: true });
  fs.writeFileSync(rawPath(), typeof value === 'string' ? value : JSON.stringify(value));
}

test('stashPath places the file under <dataDir>/bitacode/drafts.json', () => {
  assert.equal(rawPath(), path.join(dataDir, 'bitacode', 'drafts.json'));
  const fallback = path.join(os.homedir(), '.local', 'share', 'bitacode', 'drafts.json');
  assert.equal(stashPath(), process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'bitacode', 'drafts.json')
    : fallback);
});

test('saveDraft persists a draft with an id, label and timestamp', () => {
  const saved = saveDraft('hello world', 'my prompt', { dataDir });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.text, 'hello world');
  assert.equal(saved.value.label, 'my prompt');
  assert.match(saved.value.id, /^[0-9a-z]{8,12}$/);
  assert.equal(typeof saved.value.savedAt, 'number');
  assert.deepEqual(readRaw(), [saved.value]);
});

test('saveDraft uses private permissions and an atomic write with no temp leftovers', () => {
  const saved = saveDraft('secret prompt', undefined, { dataDir });
  assert.equal(saved.ok, true);
  const dir = path.dirname(rawPath());
  assert.deepEqual(fs.readdirSync(dir), ['drafts.json']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(rawPath()).mode & 0o777, 0o600);
  }
});

test('saveDraft rejects empty, whitespace-only and non-string text', () => {
  assert.equal(saveDraft('', undefined, { dataDir }).ok, false);
  assert.equal(saveDraft('   \n\t ', undefined, { dataDir }).ok, false);
  assert.equal(saveDraft(42 as unknown as string, undefined, { dataDir }).ok, false);
  assert.equal(fs.existsSync(rawPath()), false);
});

test('control characters are stripped but newline and tab survive; label is capped', () => {
  const text = 'line1\u0000\u0007\u001b\nline2\tend\u007f';
  const saved = saveDraft(text, 'a\nb'.padEnd(100, 'x'), { dataDir });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.text, 'line1\nline2\tend');
  assert.equal(saved.value.label.length, 80);
  assert.equal(saved.value.label.includes('\n'), false);
});

test('text longer than 20k characters is capped', () => {
  const saved = saveDraft('x'.repeat(25_000), undefined, { dataDir });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.text.length, 20_000);
});

test('listDrafts returns newest first and defensive copies', () => {
  const first = saveDraft('first', undefined, { dataDir });
  const second = saveDraft('second', undefined, { dataDir });
  assert.ok(first.ok && second.ok);
  const listed = listDrafts({ dataDir });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(listed.value.map((draft) => draft.text), ['second', 'first']);

  listed.value[0].text = 'mutated';
  const again = listDrafts({ dataDir });
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.equal(again.value[0].text, 'second');
});

test('listDrafts orders by savedAt, not insertion order', () => {
  const drafts: DraftStash[] = [
    { id: 'aaaaaaaa', text: 'old', label: '', savedAt: 100 },
    { id: 'bbbbbbbb', text: 'new', label: '', savedAt: 300 },
    { id: 'cccccccc', text: 'mid', label: '', savedAt: 200 },
  ];
  writeRaw(drafts);
  const listed = listDrafts({ dataDir });
  assert.ok(listed.ok);
  if (!listed.ok) return;
  assert.deepEqual(listed.value.map((draft) => draft.text), ['new', 'mid', 'old']);
});

test('popDraft removes and returns the latest draft (LIFO)', () => {
  writeRaw([
    { id: 'aaaaaaaa', text: 'old', label: '', savedAt: 100 },
    { id: 'bbbbbbbb', text: 'new', label: '', savedAt: 300 },
  ]);
  const popped = popDraft('latest', { dataDir });
  assert.equal(popped.ok, true);
  if (!popped.ok) return;
  assert.equal(popped.value.text, 'new');
  assert.deepEqual(readRaw().map((draft) => draft.text), ['old']);
});

test('popDraft accepts an explicit id and reports unknown ids', () => {
  const saved = saveDraft('target', undefined, { dataDir });
  assert.ok(saved.ok);
  const popped = popDraft(saved.value.id, { dataDir });
  assert.equal(popped.ok, true);
  if (!popped.ok) return;
  assert.equal(popped.value.id, saved.value.id);
  assert.deepEqual(readRaw(), []);
  assert.equal(popDraft(saved.value.id, { dataDir }).ok, false);
  assert.equal(popDraft('', { dataDir }).ok, false);
});

test('deleteDraft removes only the requested draft', () => {
  const a = saveDraft('a', undefined, { dataDir });
  const b = saveDraft('b', undefined, { dataDir });
  assert.ok(a.ok && b.ok);
  const gone = deleteDraft(a.value.id, { dataDir });
  assert.deepEqual(gone, { ok: true, value: true });
  assert.deepEqual(readRaw().map((draft) => draft.text), ['b']);
  assert.deepEqual(deleteDraft(a.value.id, { dataDir }), { ok: true, value: false });
});

test('corrupt JSON returns an error and is never overwritten', () => {
  writeRaw('{ not json');
  const before = fs.readFileSync(rawPath(), 'utf8');
  for (const result of [
    listDrafts({ dataDir }),
    saveDraft('new', undefined, { dataDir }),
    popDraft('latest', { dataDir }),
    deleteDraft('aaaaaaaa', { dataDir }),
  ]) {
    assert.equal(result.ok, false);
  }
  assert.equal(fs.readFileSync(rawPath(), 'utf8'), before);
});

test('structurally invalid stashes are treated as corrupt', () => {
  for (const bad of [
    { drafts: [] },
    [{ id: 'aaaaaaaa', text: 'x', label: '', savedAt: 1 }, { id: 'aaaaaaaa', text: 'y', label: '', savedAt: 2 }],
    [{ id: 'aaaaaaaa', text: 'x', label: '', savedAt: 'now' }],
  ]) {
    writeRaw(bad);
    const before = fs.readFileSync(rawPath(), 'utf8');
    const result = listDrafts({ dataDir });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(rawPath(), 'utf8'), before);
  }
});

test('at most 50 drafts are kept, oldest first', () => {
  for (let i = 0; i < 60; i++) assert.equal(saveDraft(`draft ${i}`, undefined, { dataDir }).ok, true);
  const listed = listDrafts({ dataDir });
  assert.ok(listed.ok);
  if (!listed.ok) return;
  assert.equal(listed.value.length, 50);
  assert.equal(listed.value[0].text, 'draft 59');
  assert.equal(listed.value[49].text, 'draft 10');
});

test('total stash size stays at or below 1MB', () => {
  for (let i = 0; i < 50; i++) {
    const saved = saveDraft(String(i).padStart(8, '0') + 'x'.repeat(20_000), undefined, { dataDir });
    assert.equal(saved.ok, true);
  }
  assert.ok(fs.statSync(rawPath()).size <= 1_000_000);
  const listed = listDrafts({ dataDir });
  assert.ok(listed.ok);
  if (!listed.ok) return;
  assert.ok(listed.value.length <= 50);
});

test('a missing file is an empty stash, not an error', () => {
  assert.deepEqual(listDrafts({ dataDir }), { ok: true, value: [] });
  assert.equal(popDraft('latest', { dataDir }).ok, false);
  assert.deepEqual(deleteDraft('aaaaaaaa', { dataDir }), { ok: true, value: false });
});

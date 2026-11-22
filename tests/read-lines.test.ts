import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLines } from '../src/tools/read-lines.js';
import { getAllTools, handleToolCall } from '../src/tools/index.js';
import { parseFileReadResult } from '../src/utils/file-diff.js';
import { setAllowedPathRoots } from '../src/utils/path-validation.js';
import { checkReadBefore } from '../src/utils/file-time.js';

let root: string;
let file: string;

const numbered = (count: number): string[] => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-lines-test-'));
  await setAllowedPathRoots([root]);
  file = path.join(root, 'fixture.txt');
});

test.afterEach(async () => {
  await setAllowedPathRoots([]);
  await fs.rm(root, { recursive: true, force: true });
});

async function expectError(result: Promise<string>, pattern: RegExp): Promise<void> {
  const value = await result;
  assert.match(value, /^Error:/);
  assert.match(value, pattern);
}

test('from/to reads exactly one 1-based inclusive range', async () => {
  const lines = numbered(150);
  await fs.writeFile(file, lines.join('\n'));

  assert.equal(await readLines(file, { from: 70, to: 90 }), `[lines 70-90]\n${lines.slice(69, 90).join('\n')}`);
  // A second call reads the next range; no multi-range call is needed.
  assert.equal(await readLines(file, { from: 300, to: 305 }), '[lines 300-305]\n(no lines: file has 150 line(s))');
});

test('a single "70-90" string is accepted; multiple ranges are rejected with a re-call hint', async () => {
  await fs.writeFile(file, numbered(150).join('\n'));
  const one = await readLines(file, { ranges: '70-90' });
  assert.match(one, /^\[lines 70-90\]\nline 70\n/);
  assert.equal((one.match(/\[lines /g) ?? []).length, 1, 'exactly one section');

  await expectError(readLines(file, { ranges: '70-90,90-100' }), /one range at a time.*call again/i);
});

test('out-of-range ends clamp with a note; past-EOF and empty files get read_file-style messages', async () => {
  await fs.writeFile(file, numbered(100).join('\n'));

  const clamped = await readLines(file, { from: 95, to: 120 });
  assert.match(clamped, /\[lines 95-120\]\nline 95\nline 96\nline 97\nline 98\nline 99\nline 100\n\.\.\. \(file ends at line 100\)/);
  assert.equal(
    await readLines(file, { from: 150, to: 160 }),
    '[lines 150-160]\n(no lines: file has 100 line(s))'
  );

  await fs.writeFile(file, '');
  assert.equal(await readLines(file, { from: 1, to: 3 }), '[lines 1-3]\n(empty file)');
});

test('result parses into a single display section via parseFileReadResult', async () => {
  await fs.writeFile(file, numbered(100).join('\n'));

  const result = await readLines(file, { from: 95, to: 120 });
  const parsed = parseFileReadResult('read_lines', { file_path: file, from: 95, to: 120 }, result);

  assert.ok(parsed);
  assert.equal(parsed!.filePath, file);
  assert.deepEqual(
    parsed!.sections.map((s) => [s.startLine, s.endLine, s.lines.length]),
    [[95, 120, 6]]
  );
  assert.equal(parsed!.totalLines, 100);
});

test('invalid arguments return Error strings and never throw', async () => {
  await fs.writeFile(file, numbered(100).join('\n'));

  await expectError(readLines(''), /file_path is required/);
  await expectError(readLines(file, {}), /from must be a positive integer/);
  await expectError(readLines(file, { from: 0, to: 3 }), /from must be a positive integer/);
  await expectError(readLines(file, { from: 5, to: 2 }), /greater than or equal to/);
  await expectError(readLines(file, { from: 1, to: 2, maxLines: 0 }), /max_lines must be a positive integer/);
  await expectError(readLines(file, { ranges: 'abc' }), /invalid range/);
  await expectError(readLines(file, { ranges: '' }), /invalid range/);
  await expectError(readLines(file, { from: 1, to: 100, maxLines: 50 }), /maximum is 50/);
  await expectError(readLines(file, { ranges: 12 as unknown as string }), /ranges must be a string/);
});

test('missing file, directory, binary and escaping paths are handled', async () => {
  const missing = await readLines(path.join(root, 'missing.txt'), { from: 1, to: 2 });
  assert.match(missing, /^File not found: '.*missing\.txt'/);

  const dir = path.join(root, 'a-directory');
  await fs.mkdir(dir);
  await expectError(readLines(dir, { from: 1, to: 2 }), /is a directory/);

  const binary = path.join(root, 'binary.bin');
  await fs.writeFile(binary, Buffer.from([0x68, 0x00, 0x69]));
  await expectError(readLines(binary, { from: 1, to: 2 }), /binary file/);

  await expectError(readLines('/etc/passwd', { from: 1, to: 2 }), /outside the working directory/i);
});

test('long lines are truncated at 2000 characters', async () => {
  await fs.writeFile(file, `a\n${'x'.repeat(2010)}\nc\n`);
  assert.equal(await readLines(file, { from: 2, to: 2 }), `[lines 2-2]\n${'x'.repeat(2000)}... (line truncated)`);
});

test('a successful read is recorded for staleness checks', async () => {
  await fs.writeFile(file, 'a\nb\n');
  await readLines(file, { from: 1, to: 1, sessionId: 'read-lines-session' });
  const future = new Date(Date.now() + 5000);
  await fs.utimes(file, future, future);
  assert.match(checkReadBefore('read-lines-session', file) ?? '', /changed on disk/);
});

test('tool is registered and dispatched through handleToolCall', async () => {
  const tool = getAllTools().find((t) => t.function.name === 'read_lines');
  assert.ok(tool, 'read_lines must be registered');
  assert.deepEqual(tool!.function.parameters.required, ['file_path', 'from', 'to']);

  await fs.writeFile(file, numbered(10).join('\n'));
  const byNumbers = await handleToolCall('read_lines', { file_path: file, from: 2, to: 3 }, { sessionId: 'dispatch' });
  assert.equal(byNumbers, '[lines 2-3]\nline 2\nline 3');
  assert.equal(await handleToolCall('read_lines', { file_path: file, ranges: '2-3' }), byNumbers);
  assert.match(await handleToolCall('read_lines', { ranges: '2-3' }), /requires file_path/);
});

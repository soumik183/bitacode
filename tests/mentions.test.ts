import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyMention,
  extractMentions,
  findMentionToken,
  listMentionCandidates,
  searchMentionFiles,
} from '../src/utils/mentions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-mentions-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(root, 'workspace-'));
  fs.mkdirSync(path.join(cwd, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'components', 'Button.tsx'), 'export {};\n');
  fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(cwd, 'assets'), { recursive: true });
  return cwd;
}

test('searchMentionFiles returns immediate children for an empty query, directories first', async () => {
  const cwd = makeWorkspace();
  const matches = await searchMentionFiles(cwd, '');

  assert.deepEqual(
    matches.map((match) => match.relativePath),
    ['assets', 'src', 'README.md'],
  );
  assert.equal(matches[0].isDirectory, true);
  assert.equal(matches[2].isDirectory, false);
  assert.equal(matches[2].name, 'README.md');
});

test('searchMentionFiles finds nested files with posix relative paths', async () => {
  const cwd = makeWorkspace();

  const exact = await searchMentionFiles(cwd, 'Button');
  assert.equal(exact[0].relativePath, 'src/components/Button.tsx');
  assert.equal(exact[0].isDirectory, false);
  assert.equal(exact[0].name, 'Button.tsx');

  const nested = await searchMentionFiles(cwd, 'components/but');
  assert.equal(nested[0].relativePath, 'src/components/Button.tsx');

  const fuzzy = await searchMentionFiles(cwd, 'btnts');
  assert.ok(fuzzy.some((match) => match.relativePath === 'src/components/Button.tsx'));
});

test('searchMentionFiles ranks base-name prefix above substring matches', async () => {
  const cwd = makeWorkspace();
  fs.writeFileSync(path.join(cwd, 'src', 'myindex.ts'), 'export {};\n');

  const matches = await searchMentionFiles(cwd, 'index');
  assert.equal(matches[0].relativePath, 'src/index.ts');
  assert.ok(matches.some((match) => match.relativePath === 'src/myindex.ts'));
  assert.ok(matches[0].score > matches[1].score);
});

test('searchMentionFiles skips dotfiles and capped directories', async () => {
  const cwd = makeWorkspace();
  fs.writeFileSync(path.join(cwd, '.secret'), 'hidden\n');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'ignored', 'needle.txt'), 'x\n');
  fs.mkdirSync(path.join(cwd, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a', 'b', 'c', 'deep.txt'), 'x\n');

  assert.deepEqual(await searchMentionFiles(cwd, 'needle'), []);
  assert.deepEqual(await searchMentionFiles(cwd, 'secret'), []);
  assert.deepEqual(await searchMentionFiles(cwd, 'deep'), []);
  assert.ok((await searchMentionFiles(cwd, '.secret')).some((match) => match.relativePath === '.secret'));
});

test('searchMentionFiles respects the entry cap and never throws on a missing cwd', async () => {
  const cwd = makeWorkspace();
  for (let index = 0; index < 650; index++) {
    fs.writeFileSync(path.join(cwd, `f${String(index).padStart(4, '0')}.txt`), 'x\n');
  }

  const capped = await searchMentionFiles(cwd, 'f', 1000);
  assert.ok(capped.length > 500 && capped.length <= 600, `unexpected cap: ${capped.length}`);
  assert.deepEqual(await searchMentionFiles(path.join(root, 'missing-dir'), 'anything'), []);
});

test('existing mention helpers keep their behaviour', () => {
  assert.deepEqual(findMentionToken('look @src/ap here', 12), {
    token: 'src/ap',
    start: 5,
    end: 12,
  });
  assert.equal(findMentionToken('email a@b.com', 9), null);

  const token = findMentionToken('use @Button', 11);
  assert.ok(token);
  assert.deepEqual(applyMention('use @Button', token, 'src/Button.tsx'), {
    text: 'use @src/Button.tsx',
    cursor: 19,
  });

  assert.deepEqual(extractMentions('see @src/app.ts and @review'), ['src/app.ts', 'review']);

  // listMentionCandidates is exercised with a real directory in the async test below.
});

test('listMentionCandidates lists one level with directory suffixes', async () => {
  const cwd = makeWorkspace();
  assert.deepEqual(await listMentionCandidates(cwd, ''), ['assets/', 'src/', 'README.md']);
  assert.deepEqual(await listMentionCandidates(cwd, 'src/'), ['src/components/', 'src/index.ts']);
});

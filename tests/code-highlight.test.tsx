import test from 'node:test';
import assert from 'node:assert/strict';
import { theme } from '../src/theme.js';
import {
  MAX_HIGHLIGHT_CHARS,
  detectLanguage,
  highlightCode,
  safeHighlight,
  type HighlightToken,
} from '../src/utils/code-highlight.js';

const textOf = (line: HighlightToken[]): string => line.map((token) => token.text).join('');

test('tokenizes TypeScript keywords, strings, numbers and comments', () => {
  const [line] = highlightCode('const x = 42; // note', 'ts');
  assert.deepEqual(line.map((token) => token.text), ['const', ' x = ', '42', '; ', '// note']);
  assert.equal(line[0].color, theme.accent);
  assert.equal(line[0].bold, true);
  assert.equal(line[2].color, '#b5cea8');
  assert.equal(line[4].dim, true);
});

test('double, single and backtick strings are one token each', () => {
  const [line] = highlightCode('const a = "one"; const b = \'two\'; const c = `three`;', 'ts');
  const strings = line.filter((token) => token.color === theme.success).map((token) => token.text);
  assert.deepEqual(strings, ['"one"', "'two'", '`three`']);
});

test('function calls are highlighted separately from keywords', () => {
  const [line] = highlightCode('function greet(name) { return greet(name); }', 'ts');
  const calls = line.filter((token) => token.color === '#dcdcaa').map((token) => token.text);
  assert.deepEqual(calls, ['greet', 'greet']);
});

test('block comments span multiple lines', () => {
  const lines = highlightCode('/* start\nstill a comment\nend */\nconst x = 1;', 'ts');
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(0, 3).every((line) => line.every((token) => token.dim === true || token.text.trim() === '')));
  assert.equal(lines[3][0].text, 'const');
});

test('JSON keys and string values get different colours', () => {
  const [line] = highlightCode('{"name": "Ada", "ok": true}', 'json');
  const key = line.find((token) => token.text === '"name"');
  const value = line.find((token) => token.text === '"Ada"');
  const literal = line.find((token) => token.text === 'true');
  assert.ok(key?.color);
  assert.equal(value?.color, theme.success);
  assert.equal(literal?.color, theme.info);
  assert.notEqual(key?.color, value?.color);
});

test('bash comments, keywords and strings are tokenized', () => {
  const lines = highlightCode('# setup\necho "hi" && cd /tmp', 'bash');
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0].color, theme.dim);
  assert.equal(lines[1][0].text, 'echo');
  assert.equal(lines[1][0].color, theme.accent);
  assert.equal(lines[1].find((token) => token.text === '"hi"')?.color, theme.success);
});

test('python keywords, literals and comments are tokenized', () => {
  const lines = highlightCode('def greet(name):\n    return True  # ok', 'python');
  assert.equal(lines[0][0].text, 'def');
  assert.equal(lines[0].find((token) => token.text === 'greet')?.color, '#dcdcaa');
  assert.equal(lines[1].find((token) => token.text === 'True')?.color, theme.info);
  assert.equal(lines[1].find((token) => token.text === '# ok')?.dim, true);
});

test('markdown headings, bold and inline code are tokenized', () => {
  const lines = highlightCode('# Title\n**bold** and `code`', 'markdown');
  assert.equal(lines[0][0].text, '# Title');
  assert.equal(lines[0][0].bold, true);
  assert.equal(lines[1].find((token) => token.text === '**bold**')?.bold, true);
  assert.equal(lines[1].find((token) => token.text === '`code`')?.color, theme.success);
});

test('diff lines keep their + / - colour', () => {
  const lines = highlightCode('+added\n-removed\n@@ hunk @@\n context', 'diff');
  assert.equal(lines[0][0].text, '+added');
  assert.equal(lines[0][0].color, theme.success);
  assert.equal(lines[1][0].color, theme.error);
  assert.equal(lines[2][0].color, theme.info);
  assert.equal(textOf(lines[3]), ' context');
});

test('detectLanguage resolves paths, extensions and hints', () => {
  assert.equal(detectLanguage('src/app.ts'), 'ts');
  assert.equal(detectLanguage('src/app.tsx'), 'tsx');
  assert.equal(detectLanguage('src/util.js'), 'js');
  assert.equal(detectLanguage('package.json'), 'json');
  assert.equal(detectLanguage('scripts/build.sh'), 'bash');
  assert.equal(detectLanguage('train.py'), 'python');
  assert.equal(detectLanguage('README.md'), 'markdown');
  assert.equal(detectLanguage('change.patch'), 'diff');
  assert.equal(detectLanguage('python'), 'python');
  assert.equal(detectLanguage('Dockerfile'), 'bash');
  assert.equal(detectLanguage('unknown.xyz'), 'text');
  assert.equal(detectLanguage(undefined), 'text');
});

test('unknown and text languages preserve text verbatim', () => {
  const code = 'a < b && c > d\nsecond line';
  assert.deepEqual(highlightCode(code, 'text'), [[{ text: 'a < b && c > d' }], [{ text: 'second line' }]]);
  assert.deepEqual(highlightCode(code, 'not-a-language'), highlightCode(code, 'text'));
});

test('input is capped so highlighting stays cheap', () => {
  assert.equal(textOf(highlightCode('a'.repeat(300), 'text', { maxChars: 10 })[0]).length, 10);
  const huge = highlightCode('x'.repeat(MAX_HIGHLIGHT_CHARS + 100), 'ts');
  assert.ok(textOf(huge[0]).length <= MAX_HIGHLIGHT_CHARS);
});

test('ANSI escape sequences are passed through without being styled', () => {
  const [line] = highlightCode('\x1b[31mred\x1b[0m', 'bash');
  assert.equal(line[0].text, '\x1b[31m');
  assert.equal(line[0].color, undefined);
  assert.equal(line[2].text, '\x1b[0m');
  assert.equal(textOf(line), '\x1b[31mred\x1b[0m');
});

test('malformed input never crashes safeHighlight', () => {
  assert.throws(() => highlightCode(42 as unknown as string, 'ts'), TypeError);
  assert.deepEqual(safeHighlight(42, 'ts'), [[{ text: '42' }]]);
  assert.deepEqual(safeHighlight(null), [[{ text: '' }]]);
  assert.deepEqual(safeHighlight('const x = 1', 'ts'), highlightCode('const x = 1', 'ts'));
});

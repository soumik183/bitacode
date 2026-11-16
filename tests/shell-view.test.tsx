import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellView } from '../src/components/ShellView.js';
import { parseShellResult } from '../src/utils/shell-result.js';

test('bash results become a shell display model', () => {
  const parsed = parseShellResult('bash', JSON.stringify({ command: 'ls -la' }), 'one\ntwo\n');
  assert.ok(parsed);
  assert.equal(parsed.command, 'ls -la');
  assert.equal(parsed.isError, false);
  assert.equal(parsed.status, undefined);
  assert.equal(parsed.output, 'one\ntwo\n');
});

test('failed bash results carry an exit status', () => {
  const parsed = parseShellResult(
    'bash',
    JSON.stringify({ command: 'false' }),
    'Command exited with code 1.\nstdout:\n\nstderr:\n'
  );
  assert.ok(parsed);
  assert.equal(parsed.isError, true);
  assert.equal(parsed.status, 'exit 1');
});

test('other tools do not become shell cards', () => {
  assert.equal(parseShellResult('read_file', '{}', 'contents'), null);
  assert.equal(parseShellResult('bash', '{}', 'output'), null);
});

test('shell card collapses long output and expands it again', () => {
  const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n');
  const collapsed = render(
    <ShellView command="ls" output={output} isError={false} expanded={false} />
  ).lastFrame() ?? '';
  assert.match(collapsed, /Shell/);
  assert.match(collapsed, /❯ ls/);
  assert.match(collapsed, /line 1/);
  assert.match(collapsed, /line 4/);
  assert.doesNotMatch(collapsed, /line 5/);
  assert.match(collapsed, /4 more lines/);
  assert.match(collapsed, /click to expand/);

  const expanded = render(
    <ShellView command="ls" output={output} isError={false} expanded />
  ).lastFrame() ?? '';
  assert.match(expanded, /line 8/);
  assert.match(expanded, /click to collapse/);
  assert.doesNotMatch(expanded, /more lines/);
});

test('shell card strips terminal escape codes from output', () => {
  const parsed = parseShellResult(
    'bash',
    JSON.stringify({ command: 'printf' }),
    '\x1b[31mred\x1b[0m\n'
  )!;
  const frame = render(<ShellView {...parsed} />).lastFrame() ?? '';
  assert.match(frame, /red/);
  assert.ok(!frame.includes('\x1b[31m'));
});

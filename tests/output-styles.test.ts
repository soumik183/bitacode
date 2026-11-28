import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_OUTPUT_STYLE,
  getOutputStyle,
  listOutputStyles,
  outputStyleSection,
} from '../src/utils/output-styles.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('built-in output styles are listed and default has no prompt body', () => {
  const home = tempDir('bitacode-style-home-');
  const cwd = tempDir('bitacode-style-cwd-');
  try {
    const styles = listOutputStyles({ cwd, home });
    assert.ok(styles.some((style) => style.id === 'concise'));
    assert.ok(styles.some((style) => style.id === 'explanatory'));

    assert.equal(outputStyleSection(DEFAULT_OUTPUT_STYLE, { cwd, home }), '');
    assert.match(outputStyleSection('concise', { cwd, home }), /maximally concise/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('project styles override user styles with the same id', () => {
  const home = tempDir('bitacode-style-home2-');
  const cwd = tempDir('bitacode-style-cwd2-');
  try {
    const userDir = path.join(home, '.config', 'bitacode', 'output-styles');
    const projectDir = path.join(cwd, '.bitacode', 'output-styles');
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(userDir, 'terse.md'),
      '---\nname: Terse\ndescription: user copy\n---\nUSER BODY\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'terse.md'),
      '---\nname: Terse Pro\ndescription: project copy\n---\nPROJECT BODY\n',
    );

    const style = getOutputStyle('terse', { cwd, home });
    assert.equal(style.name, 'Terse Pro');
    assert.equal(style.source, 'project');
    assert.match(outputStyleSection('terse', { cwd, home }), /PROJECT BODY/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

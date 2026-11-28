import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadInstructionContext,
  renderInstructionContext,
} from '../src/utils/rules.js';

test('instruction files merge from nearest directories and expand @imports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-rules-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const nested = path.join(project, 'src');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  try {
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'ROOT RULES\n@./docs/style.md\n');
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'style.md'), 'IMPORTED STYLE\n');
    fs.writeFileSync(path.join(nested, 'CLAUDE.md'), 'NESTED RULES\n');
    fs.writeFileSync(path.join(nested, '.cursorrules'), 'CURSOR RULES\n');

    const context = await loadInstructionContext({ cwd: nested, home });
    const rendered = renderInstructionContext(context);

    assert.match(rendered, /ROOT RULES/);
    assert.match(rendered, /IMPORTED STYLE/);
    assert.match(rendered, /NESTED RULES/);
    assert.match(rendered, /CURSOR RULES/);

    // Nearest file must come after the root file so it applies last.
    assert.ok(rendered.indexOf('ROOT RULES') < rendered.indexOf('NESTED RULES'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no instruction files yields an empty section', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-rules-empty-'));
  try {
    const context = await loadInstructionContext({ cwd: root, home: path.join(root, 'home') });
    assert.equal(renderInstructionContext(context), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

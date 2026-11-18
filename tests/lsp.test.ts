import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { diagnostics, findReferences, goToDefinition } from '../src/tools/lsp.js';

const DIR = path.join(process.cwd(), 'tests', 'tmp-lsp-proj');
const REL = path.relative(process.cwd(), DIR);

async function setup(withTsconfig = false): Promise<void> {
  await fsp.rm(DIR, { recursive: true, force: true });
  await fsp.mkdir(path.join(DIR, 'src'), { recursive: true });
  await fsp.writeFile(path.join(DIR, 'src', 'alpha.ts'), [
    'export function alpha(count: number): number {',
    '  return count + 1;',
    '}',
    'const total = alpha(2);',
    'export class Alpha {}',
    '',
  ].join('\n'), 'utf8');
  if (withTsconfig) {
    await fsp.writeFile(path.join(DIR, 'tsconfig.json'), JSON.stringify({ compilerOptions: {}, files: [] }), 'utf8');
  }
}

test('goToDefinition finds declarations by regex heuristic', async () => {
  await setup();
  try {
    const result = await goToDefinition('alpha', REL);
    assert.match(result, /Found 1 definition/);
    assert.match(result, /function alpha/);
    assert.doesNotMatch(result, /alpha\(2\)/);

    const invalid = await goToDefinition('   ', REL);
    assert.match(invalid, /symbol is required/i);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

test('findReferences finds usages across the repo', async () => {
  await setup();
  try {
    const result = await findReferences('alpha', REL);
    assert.match(result, /alpha\(2\)/);
    assert.match(result, /function alpha/);
    assert.match(result, /src\/alpha\.ts/);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

test('diagnostics reports a missing tsconfig instead of throwing', async () => {
  await setup();
  try {
    assert.match(await diagnostics(REL), /No tsconfig.json found/);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

test('diagnostics runs tsc when a tsconfig exists and returns a string', async () => {
  await setup(true);
  try {
    const result = await diagnostics(REL);
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  } finally {
    await fsp.rm(DIR, { recursive: true, force: true });
  }
});

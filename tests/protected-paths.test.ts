import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertWritablePath, isProtectedPath } from '../src/utils/protected-paths.js';

const cwd = path.resolve(process.cwd());

test('protected directories are not writable', () => {
  assert.equal(isProtectedPath(path.join(cwd, '.git', 'config'), cwd), true);
  assert.equal(isProtectedPath(path.join(cwd, '.bitacode', 'hooks.json'), cwd), true);
  assert.equal(isProtectedPath(path.join(cwd, '.ssh', 'id_rsa'), cwd), true);
});

test('ordinary source files are writable', () => {
  assert.equal(isProtectedPath(path.join(cwd, 'src', 'cli.tsx'), cwd), false);
  assert.equal(isProtectedPath(path.join(cwd, 'README.md'), cwd), false);
});

test('assertWritablePath throws with an actionable message', () => {
  assert.throws(
    () => assertWritablePath(path.join(cwd, '.git', 'HEAD'), cwd),
    /protected location/i,
  );
  assert.doesNotThrow(() => assertWritablePath(path.join(cwd, 'src', 'cli.tsx'), cwd));
});

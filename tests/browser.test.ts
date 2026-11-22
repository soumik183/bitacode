import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { browserCandidates, openInBrowser, REPO_URL, BUG_REPORT_URL } from '../src/utils/browser.js';
import { SLASH_COMMANDS } from '../src/components/Palette.js';

class FakeChild extends EventEmitter {
  killed = false;
  kill(): void { this.killed = true; }
}

function stubSpawn(codes: number[] = [0]) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let index = 0;
  const spawnFn = (command: string, args: readonly string[]): ChildProcess => {
    calls.push({ command, args: [...args] });
    const child = new FakeChild() as unknown as ChildProcess;
    const code = codes[Math.min(index, codes.length - 1)] ?? 0;
    index++;
    setImmediate(() => (child as unknown as FakeChild).emit('close', code));
    return child;
  };
  return { calls, spawnFn };
}

test('URLs are fixed project links', () => {
  assert.equal(REPO_URL, 'https://github.com/soumik183/bitacode');
  assert.equal(BUG_REPORT_URL, `${REPO_URL}/issues/new`);
});

test('both commands are in the slash palette with descriptions', () => {
  for (const [name, description] of [
    ['/github', 'Open the Bitacode repository in your browser'],
    ['/bug', 'Open the GitHub bug report form'],
  ]) {
    const command = SLASH_COMMANDS.find((item) => item.name === name);
    assert.ok(command, `${name} is registered`);
    assert.equal(command!.description, description);
  }
});

test('Android candidates try Chrome first, then the default handlers', () => {
  const candidates = browserCandidates(REPO_URL, 'android');
  assert.equal(candidates[0].command, 'am');
  assert.ok(candidates[0].args.includes('com.android.chrome'));
  assert.equal(candidates[1].command, 'termux-open-url');
  assert.ok(candidates[2].args.includes(REPO_URL), 'final default handler carries the URL');
});

test('default-browser preference skips the Chrome attempt', () => {
  const candidates = browserCandidates(REPO_URL, 'android', 'default');
  assert.notEqual(candidates[0].command, 'am');
  assert.equal(candidates[0].command, 'termux-open-url');
});

test('a custom browser command takes priority', () => {
  const candidates = browserCandidates(REPO_URL, 'android', 'firefox');
  assert.deepEqual(candidates, [{ command: 'firefox', args: [REPO_URL] }]);
});

test('desktop candidates use the platform opener', () => {
  assert.equal(browserCandidates(REPO_URL, 'linux')[0].command, 'xdg-open');
  assert.equal(browserCandidates(REPO_URL, 'darwin')[0].command, 'open');
  assert.equal(browserCandidates(REPO_URL, 'win32')[0].command, 'cmd');
});

test('openInBrowser stops at the first successful candidate', async () => {
  const { calls, spawnFn } = stubSpawn([0, 0, 0]);
  const message = await openInBrowser(REPO_URL, spawnFn);
  assert.match(message, /^Opened in browser:/);
  assert.equal(calls.length, 1, 'Chrome attempt succeeded; no fallback was used');
});

test('openInBrowser falls through when Chrome fails', async () => {
  const { calls, spawnFn } = stubSpawn([1, 0, 0]);
  const message = await openInBrowser(BUG_REPORT_URL, spawnFn);
  assert.match(message, /^Opened in browser:/);
  assert.equal(calls.length, 2, 'second candidate was used');
  assert.ok(calls[0].args.includes('com.android.chrome'));
});

test('openInBrowser never throws and reports the URL when all candidates fail', async () => {
  const { calls, spawnFn } = stubSpawn([1, 1, 1]);
  const message = await openInBrowser(REPO_URL, spawnFn);
  assert.equal(message, `Open manually: ${REPO_URL}`);
  assert.equal(calls.length, 3);
  assert.match(await openInBrowser('javascript:alert(1)', spawnFn), /^Error: invalid URL/);
});

test('a spawn error falls through to the next candidate', async () => {
  const calls: string[] = [];
  const spawnFn = ((command: string): ChildProcess => {
    calls.push(command);
    if (command === 'am') throw new Error('not found');
    const child = new FakeChild() as unknown as ChildProcess;
    setImmediate(() => (child as unknown as FakeChild).emit('close', 0));
    return child;
  });
  const message = await openInBrowser(REPO_URL, spawnFn);
  assert.match(message, /^Opened in browser:/);
  assert.deepEqual(calls.slice(0, 2), ['am', 'termux-open-url']);
});

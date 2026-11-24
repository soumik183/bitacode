import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertShellAllowable,
  scanShell,
  splitShellCommands,
  type ShellScan,
} from '../src/utils/shell-scan.js';

test('simple command is low risk and exposes its word tokens', () => {
  const scan = scanShell('git status');
  assert.equal(scan.commands.length, 1);
  assert.deepEqual(scan.commands[0], {
    text: 'git status',
    op: null,
    args: ['git', 'status'],
    redirections: [],
  });
  assert.equal(scan.hasPipe, false);
  assert.equal(scan.hasChain, false);
  assert.equal(scan.hasRedirection, false);
  assert.equal(scan.risk, 'low');
  assert.ok(scan.reasons.length > 0);
});

test('a semicolon inside quotes is data, not a chain', () => {
  const scan = scanShell('echo "a;b"');
  assert.equal(scan.commands.length, 1);
  assert.deepEqual(scan.commands[0].args, ['echo', 'a;b']);
  assert.equal(scan.hasChain, false);
  assert.equal(scan.risk, 'low');
});

test('&& chains produce two commands and high risk', () => {
  const scan = scanShell('echo a && echo b');
  assert.equal(scan.hasChain, true);
  assert.deepEqual(scan.commands.map((entry) => entry.text), ['echo a', 'echo b']);
  assert.equal(scan.commands[1].op, '&&');
  assert.equal(scan.risk, 'high');
  assert.ok(scan.reasons.some((reason) => /chain/i.test(reason)));
});

test('pipes are medium risk and split into segments', () => {
  const scan = scanShell('cat file | grep x');
  assert.equal(scan.hasPipe, true);
  assert.equal(scan.hasChain, false);
  assert.deepEqual(scan.commands.map((entry) => entry.text), ['cat file', 'grep x']);
  assert.equal(scan.commands[1].op, '|');
  assert.equal(scan.risk, 'medium');
});

test('redirection targets are not reported as arguments', () => {
  const scan = scanShell('echo hi > out.txt');
  assert.equal(scan.hasRedirection, true);
  assert.deepEqual(scan.commands[0].redirections, ['>']);
  assert.deepEqual(scan.commands[0].args, ['echo', 'hi']);
  assert.equal(scan.risk, 'medium');
});

test('file-descriptor redirection is one operator', () => {
  const scan: ShellScan = scanShell('git status 2>&1 || echo fail');
  assert.deepEqual(scan.commands[0].redirections, ['2>&1']);
  assert.equal(scan.hasRedirection, true);
  assert.equal(scan.hasChain, true);
  assert.equal(scan.risk, 'high');
  assert.deepEqual(scan.commands.map((entry) => entry.text), ['git status 2>&1', 'echo fail']);
});

test('command substitution is high risk', () => {
  const scan = scanShell('echo $(whoami)');
  assert.equal(scan.hasSubstitution, true);
  assert.equal(scan.risk, 'high');
  assert.ok(scan.reasons.some((reason) => /substitution/i.test(reason)));
});

test('backticks are high risk even inside double quotes', () => {
  const scan = scanShell('echo "value: `id`"');
  assert.equal(scan.hasSubstitution, true);
  assert.equal(scan.risk, 'high');
  assert.equal(scan.commands.length, 1);
});

test('process substitution is high risk without splitting on inner operators', () => {
  const scan = scanShell('diff <(ls; whoami) <(ls -a)');
  assert.equal(scan.hasSubstitution, true);
  assert.equal(scan.hasChain, false);
  assert.equal(scan.commands.length, 1);
  assert.equal(scan.risk, 'high');
});

test('unterminated quotes are reported, not thrown', () => {
  assert.doesNotThrow(() => scanShell("echo 'oops"));
  const single = scanShell("echo 'oops");
  assert.equal(single.risk, 'high');
  assert.ok(single.reasons.some((reason) => /unterminated single quote/i.test(reason)));
  const double = scanShell('echo "unterminated');
  assert.equal(double.risk, 'high');
  assert.ok(double.reasons.some((reason) => /unterminated double quote/i.test(reason)));
});

test('comments stop scanning at the end of the line', () => {
  const scan = scanShell('echo hi # trailing ; rm -rf /');
  assert.deepEqual(scan.commands.map((entry) => entry.text), ['echo hi']);
  assert.equal(scan.hasChain, false);
  assert.equal(scan.risk, 'low');
  assert.deepEqual(splitShellCommands('# only a comment'), []);
});

test('newlines and background operators are detected', () => {
  const newline = scanShell('echo one\necho two');
  assert.equal(newline.commands.length, 2);
  assert.equal(newline.risk, 'high');
  const background = scanShell('sleep 5 &');
  assert.equal(background.hasBackground, true);
  assert.equal(background.risk, 'high');
});

test('line continuations and tabs are handled without executing anything', () => {
  const scan = scanShell('echo one\\\ntwo');
  assert.deepEqual(scan.commands[0].args, ['echo', 'onetwo']);
  assert.equal(scan.risk, 'low');
  assert.deepEqual(scanShell('echo\ta\tb').commands[0].args, ['echo', 'a', 'b']);
});

test('empty input is low risk with a reason', () => {
  const scan = scanShell('');
  assert.deepEqual(scan.commands, []);
  assert.equal(scan.risk, 'low');
  assert.ok(scan.reasons.some((reason) => /empty/i.test(reason)));
});

test('allowed prefixes are accepted, including prefixes with arguments', () => {
  assert.deepEqual(assertShellAllowable('git status', ['git']), { allowed: true });
  assert.deepEqual(assertShellAllowable('git status --short', ['git status']), { allowed: true });
  assert.deepEqual(assertShellAllowable('git\tstatus --short', ['git status']), { allowed: true });
});

test('unknown prefixes are denied with a reason naming the segment', () => {
  const result = assertShellAllowable('rm -rf /', ['git', 'pwd']);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /rm -rf \/.*not covered/);
});

test('every segment of a pipe must be allowed', () => {
  const ok = assertShellAllowable('git status | head', ['git', 'head']);
  assert.equal(ok.allowed, true);
  const denied = assertShellAllowable('git status | rm -rf /', ['git']);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /rm -rf \//);
});

test('high-risk structure fails closed even when the first segment is allowed', () => {
  const chained = assertShellAllowable('git status && rm -rf /', ['git']);
  assert.equal(chained.allowed, false);
  assert.match(chained.reason ?? '', /high-risk/);
  const substituted = assertShellAllowable('git $(whoami)', ['git']);
  assert.equal(substituted.allowed, false);
  assert.match(substituted.reason ?? '', /high-risk/);
  assert.equal(assertShellAllowable('git status', []).allowed, false);
});

test('oversized input is high risk and never allowed', () => {
  const long = 'a'.repeat(100_001);
  const scan = scanShell(long);
  assert.equal(scan.risk, 'high');
  assert.ok(scan.reasons.some((reason) => /limit|characters/i.test(reason)));
  assert.equal(assertShellAllowable(long, ['a']).allowed, false);
});

test('token floods are capped at 4096 tokens and fail closed', () => {
  const scan = scanShell('x '.repeat(5000));
  assert.equal(scan.risk, 'high');
  assert.ok(scan.reasons.some((reason) => /token limit/i.test(reason)));
  assert.equal(assertShellAllowable('x '.repeat(5000), ['x']).allowed, false);
});

test('splitShellCommands returns trimmed subcommands in source order', () => {
  assert.deepEqual(splitShellCommands('echo a; echo b | grep c'), ['echo a', 'echo b', 'grep c']);
  assert.deepEqual(splitShellCommands('   '), []);
});

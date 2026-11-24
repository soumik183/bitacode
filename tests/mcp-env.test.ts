/**
 * Tests for the MCP stdio environment allowlist and the `bitacode mcp`
 * subcommand. All filesystem work happens in temporary directories; no MCP
 * server process is spawned.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMcpEnv, parseEnvAllowlist, redactHeaders } from '../src/utils/mcp-env.js';
import { runMcpCommand, type McpCommandIO } from '../src/commands/mcp.js';

function tempCwd(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-mcp-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configPath(cwd: string): string {
  return path.join(cwd, '.bitacode', 'bitacode.jsonc');
}

function writeConfig(cwd: string, text: string): void {
  fs.mkdirSync(path.dirname(configPath(cwd)), { recursive: true });
  fs.writeFileSync(configPath(cwd), text, 'utf8');
}

function recorder(cwd: string): { lines: string[]; errors: string[]; io: McpCommandIO } {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: McpCommandIO = {
    cwd,
    out: (s: string) => lines.push(s),
    err: (s: string) => errors.push(s),
  };
  return { lines, errors, io };
}

// ─── Feature A: allowlist ───

test('parseEnvAllowlist keeps valid names, dedupes and skips bad entries', () => {
  assert.deepEqual(
    parseEnvAllowlist(['PATH', '_PRIVATE', 'A1_b', 'PATH', '', '1BAD', 'has space', 'A-B', null, 42, {}]),
    ['PATH', '_PRIVATE', 'A1_b'],
  );
});

test('parseEnvAllowlist accepts record keys and ignores their values', () => {
  assert.deepEqual(parseEnvAllowlist({ FOO: 'secret', BAR: 'value', 'bad-key': 'x', '': 'y' }), ['FOO', 'BAR']);
});

test('parseEnvAllowlist never throws on unexpected input', () => {
  for (const value of [undefined, null, 7, 'FOO', true, () => 'FOO']) {
    assert.deepEqual(parseEnvAllowlist(value), []);
  }
});

test('buildMcpEnv does not leak provider keys from process.env', () => {
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    BITACODE_API_KEY: process.env.BITACODE_API_KEY,
  };
  process.env.OPENAI_API_KEY = 'sk-leak-openai';
  process.env.ANTHROPIC_API_KEY = 'sk-leak-anthropic';
  process.env.BITACODE_API_KEY = 'sk-leak-bitacode';
  try {
    const env = buildMcpEnv({ allowed: ['PATH'] });
    const serialized = JSON.stringify(env);
    assert.ok(!serialized.includes('sk-leak-'), 'no provider secret value leaks');
    assert.ok(!('OPENAI_API_KEY' in env));
    assert.ok(!('ANTHROPIC_API_KEY' in env));
    assert.ok(!('BITACODE_API_KEY' in env));
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'PATH'), 'baseline PATH is present');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('buildMcpEnv copies only allowlisted process.env keys plus baseline', () => {
  process.env.MCP_TEST_ALLOWED = 'visible-value';
  process.env.MCP_TEST_HIDDEN = 'hidden-value';
  try {
    const env = buildMcpEnv({ allowed: ['MCP_TEST_ALLOWED', 'MCP_TEST_HIDDEN'] });
    // Only the explicitly allowed key is copied; the other is not part of the
    // allowlist in this call.
    const partial = buildMcpEnv({ allowed: ['MCP_TEST_ALLOWED'] });
    assert.equal(partial.MCP_TEST_ALLOWED, 'visible-value');
    assert.ok(!('MCP_TEST_HIDDEN' in partial));
    assert.equal(env.MCP_TEST_HIDDEN, 'hidden-value');
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'HOME'));
  } finally {
    delete process.env.MCP_TEST_ALLOWED;
    delete process.env.MCP_TEST_HIDDEN;
  }
});

test('buildMcpEnv extra values override allowlisted values and invalid names are skipped', () => {
  process.env.MCP_TEST_EXTRA = 'from-process';
  try {
    const env = buildMcpEnv({
      allowed: ['MCP_TEST_EXTRA'],
      extra: { MCP_TEST_EXTRA: 'explicit', 'bad-name': 'skip', '': 'skip' },
    });
    assert.equal(env.MCP_TEST_EXTRA, 'explicit');
    assert.ok(!('bad-name' in env));
    assert.ok(!('' in env));
  } finally {
    delete process.env.MCP_TEST_EXTRA;
  }
});

test('buildMcpEnv honours injected baseline and NODE_PATH only when supplied', () => {
  const env = buildMcpEnv({
    allowed: [],
    baseline: { PATH: '/custom/bin', HOME: '/custom/home', NODE_PATH: '/custom/node_modules', '9BAD': 'x' },
  });
  assert.equal(env.PATH, '/custom/bin');
  assert.equal(env.HOME, '/custom/home');
  assert.equal(env.NODE_PATH, '/custom/node_modules');
  assert.ok(!('9BAD' in env));
});

test('redactHeaders masks sensitive keys case-insensitively and never mutates input', () => {
  const input = {
    Authorization: 'Bearer super-secret',
    'x-api-key': 'abc123',
    SESSION_TOKEN: 't',
    Cookie: 'sid=1',
    'x-trace-id': 'trace-1',
  };
  const redacted = redactHeaders(input);
  assert.equal(redacted.Authorization, '***');
  assert.equal(redacted['x-api-key'], '***');
  assert.equal(redacted.SESSION_TOKEN, '***');
  assert.equal(redacted.Cookie, '***');
  assert.equal(redacted['x-trace-id'], 'trace-1');
  assert.equal(input.Authorization, 'Bearer super-secret', 'input unchanged');
});

test('redactHeaders skips bad entries and never throws', () => {
  const hostile = Object.create(null) as Record<string, string>;
  hostile.Authorization = 'secret';
  hostile[''] = 'empty-name';
  assert.deepEqual(redactHeaders(hostile), { Authorization: '***' });
  assert.deepEqual(redactHeaders(null as unknown as Record<string, string>), {});
});

// ─── Feature B: CLI command ───

test('mcp add/list/show/remove round-trip in a temp cwd', async (t) => {
  const cwd = tempCwd(t);
  const added = recorder(cwd);
  assert.equal(await runMcpCommand(['add', 'demo', 'node', 'server.js', '--flag'], added.io), 0);
  assert.match(added.lines.join('\n'), /Added MCP server "demo"/);

  const stored = JSON.parse(fs.readFileSync(configPath(cwd), 'utf8'));
  assert.deepEqual(stored.mcp.servers.demo, {
    type: 'stdio',
    command: 'node',
    args: ['server.js', '--flag'],
    env: [],
  });

  const listed = recorder(cwd);
  assert.equal(await runMcpCommand(['list'], listed.io), 0);
  const table = listed.lines.join('\n');
  assert.match(table, /NAME/);
  assert.match(table, /demo/);
  assert.match(table, /stdio/);
  assert.match(table, /true/);
  assert.match(table, /bitacode\.jsonc/);

  const shown = recorder(cwd);
  assert.equal(await runMcpCommand(['show', 'demo'], shown.io), 0);
  assert.match(shown.lines.join('\n'), /command: node/);
  assert.match(shown.lines.join('\n'), /args: server\.js --flag/);

  const removed = recorder(cwd);
  assert.equal(await runMcpCommand(['remove', 'demo'], removed.io), 0);
  const after = recorder(cwd);
  assert.equal(await runMcpCommand(['list'], after.io), 0);
  assert.match(after.lines.join('\n'), /No MCP servers configured/);
});

test('mcp add creates directory 0700 and file 0600', async (t) => {
  const cwd = tempCwd(t);
  const rec = recorder(cwd);
  assert.equal(await runMcpCommand(['add', 'secure', 'node'], rec.io), 0);
  assert.equal(fs.statSync(path.join(cwd, '.bitacode')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configPath(cwd)).mode & 0o777, 0o600);
});

test('mcp add preserves existing comments in JSONC', async (t) => {
  const cwd = tempCwd(t);
  writeConfig(cwd, '{\n  // keep me\n  "mcp": { "servers": {} }\n}\n');
  const rec = recorder(cwd);
  assert.equal(await runMcpCommand(['add', 'commented', 'node'], rec.io), 0);
  const text = fs.readFileSync(configPath(cwd), 'utf8');
  assert.match(text, /\/\/ keep me/);
  assert.match(text, /commented/);
});

test('mcp test validates shape and prints env names only, never values', async (t) => {
  const cwd = tempCwd(t);
  writeConfig(cwd, JSON.stringify({
    mcp: { servers: { demo: { type: 'stdio', command: 'node', args: [], env: ['MCP_SHOWN_KEY'] } } },
  }));
  process.env.MCP_SHOWN_KEY = 'super-secret-value';
  try {
    const rec = recorder(cwd);
    assert.equal(await runMcpCommand(['test', 'demo'], rec.io), 0);
    const output = rec.lines.join('\n');
    assert.match(output, /well-formed/);
    assert.match(output, /MCP_SHOWN_KEY/);
    assert.ok(!output.includes('super-secret-value'), 'env values are never printed');
    assert.deepEqual(rec.errors, []);
  } finally {
    delete process.env.MCP_SHOWN_KEY;
  }
});

test('mcp test reports malformed server config as an error', async (t) => {
  const cwd = tempCwd(t);
  writeConfig(cwd, JSON.stringify({ mcp: { servers: { bad: { type: 'stdio', args: [] } } } }));
  const rec = recorder(cwd);
  assert.equal(await runMcpCommand(['test', 'bad'], rec.io), 1);
  assert.match(rec.lines.join('\n'), /not well-formed/);
  assert.match(rec.errors.join('\n'), /missing command/);
});

test('mcp list and show handle http servers with redacted headers', async (t) => {
  const cwd = tempCwd(t);
  writeConfig(cwd, JSON.stringify({
    mcp: {
      servers: {
        remote: {
          type: 'http',
          url: 'https://example.test/mcp',
          enabled: false,
          headers: { Authorization: 'Bearer secret-token', 'X-Trace': 'trace-1' },
        },
      },
    },
  }));
  const listed = recorder(cwd);
  assert.equal(await runMcpCommand(['list'], listed.io), 0);
  assert.match(listed.lines.join('\n'), /remote\s+http\s+false/);

  const shown = recorder(cwd);
  assert.equal(await runMcpCommand(['show', 'remote'], shown.io), 0);
  const output = shown.lines.join('\n');
  assert.match(output, /Authorization=\*\*\*/);
  assert.ok(!output.includes('secret-token'));
  assert.match(output, /X-Trace=trace-1/);
});

test('mcp rejects invalid server names and path traversal', async (t) => {
  const cwd = tempCwd(t);
  for (const name of ['../evil', 'a/../b', '..', '.hidden', 'bad name', 'x\\y', 'a..b']) {
    const rec = recorder(cwd);
    assert.equal(await runMcpCommand(['add', name, 'node'], rec.io), 1, name);
    assert.match(rec.errors.join('\n'), /Invalid MCP server name/);
  }
  assert.equal(fs.existsSync(configPath(cwd)), false, 'no config created for invalid names');
});

test('mcp returns usage code 2 for bad invocations', async (t) => {
  const cwd = tempCwd(t);
  for (const args of [['unknown'], ['add'], ['add', 'only-name'], ['remove'], ['show'], ['test']]) {
    const rec = recorder(cwd);
    assert.equal(await runMcpCommand(args, rec.io), 2, args.join(' '));
    assert.ok(rec.errors.length > 0);
  }
});

test('mcp returns error 1 for missing, duplicate or malformed entries', async (t) => {
  const cwd = tempCwd(t);
  const missing = recorder(cwd);
  assert.equal(await runMcpCommand(['show', 'ghost'], missing.io), 1);
  assert.equal(await runMcpCommand(['add', 'dup', 'node'], recorder(cwd).io), 0);
  const duplicate = recorder(cwd);
  assert.equal(await runMcpCommand(['add', 'dup', 'node'], duplicate.io), 1);
  assert.match(duplicate.errors.join('\n'), /already exists/);
});

test('mcp never overwrites a corrupt config file', async (t) => {
  const cwd = tempCwd(t);
  const corrupt = '{\n  // broken\n  "mcp": { "servers": { "x": ';
  writeConfig(cwd, corrupt);
  for (const args of [['add', 'safe', 'node'], ['remove', 'x'], ['list']]) {
    const rec = recorder(cwd);
    assert.equal(await runMcpCommand(args, rec.io), 1, args.join(' '));
    assert.match(rec.errors.join('\n'), /Invalid JSONC/);
    assert.equal(fs.readFileSync(configPath(cwd), 'utf8'), corrupt, 'file unchanged');
  }
});

test('mcp reports fs failures without throwing', async (t) => {
  const cwd = tempCwd(t);
  const blocker = path.join(cwd, '.bitacode');
  fs.writeFileSync(blocker, 'not a directory');
  const rec = recorder(cwd);
  assert.equal(await runMcpCommand(['add', 'x', 'node'], rec.io), 1);
  assert.ok(rec.errors.length > 0);
});

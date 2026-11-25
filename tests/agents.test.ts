/**
 * Tests for markdown-defined named agents: discovery, validation, selection,
 * catalog rendering and tool filtering.
 */

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LogLevel, onLog } from '../src/utils/logger.js';
import {
  BUILTIN_AGENTS,
  applyAgentTools,
  discoverAgents,
  getAgent,
  renderAgentCatalog,
  resolveAgentSelection,
} from '../src/agents.js';

async function tempDirs(t: TestContext): Promise<{ cwd: string; home: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-agents-cwd-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-agents-home-'));
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  return { cwd, home };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function agentDoc(name: string, extras = '', body = 'Follow the task instructions.'): string {
  return `---\nname: ${name}\ndescription: ${name} agent\n${extras}---\n\n${body}\n`;
}

function collectWarnings(t: TestContext): string[] {
  const messages: string[] = [];
  t.after(onLog((entry) => {
    if (entry.level === LogLevel.WARN) messages.push(entry.message);
  }));
  return messages;
}

function names(agents: { name: string }[]): string[] {
  return agents.map((agent) => agent.name);
}

test('discovery always includes the three built-in agents', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const result = discoverAgents({ cwd, home });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((agent) => agent.name), ['build', 'plan', 'general']);
  for (const builtin of BUILTIN_AGENTS) {
    assert.equal(getAgent(builtin.name, result.value)?.source, 'builtin');
  }
  assert.equal(result.value.length, BUILTIN_AGENTS.length);
});

test('discovery reads agents from all four project and user roots', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const locations: Array<[string, string]> = [
    [path.join(cwd, '.bitacode', 'agents', 'project-primary.md'), 'project-primary'],
    [path.join(cwd, '.agents', 'agents', 'project-secondary.md'), 'project-secondary'],
    [path.join(home, '.config', 'bitacode', 'agents', 'user-config.md'), 'user-config'],
    [path.join(home, '.bitacode', 'agents', 'user-home.md'), 'user-home'],
  ];
  for (const [filePath, name] of locations) {
    await writeFile(filePath, agentDoc(name, '', `Prompt for ${name}.`));
  }

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(names(result.value).sort(), [
    'build', 'general', 'plan', 'project-primary', 'project-secondary', 'user-config', 'user-home',
  ]);
  for (const [filePath, name] of locations) {
    assert.equal(getAgent(name, result.value)?.source, filePath);
    assert.equal(getAgent(name, result.value)?.prompt, `Prompt for ${name}.`);
  }
});

test('project agents override user agents with the same name', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const duplicate = (description: string): string =>
    `---\nname: duplicate\ndescription: ${description}\n---\n\nBody.\n`;

  await writeFile(path.join(home, '.bitacode', 'agents', 'duplicate.md'), duplicate('user home'));
  await writeFile(path.join(home, '.config', 'bitacode', 'agents', 'duplicate.md'), duplicate('user config'));
  await writeFile(path.join(cwd, '.agents', 'agents', 'duplicate.md'), duplicate('project agents'));
  await writeFile(path.join(cwd, '.bitacode', 'agents', 'duplicate.md'), duplicate('project bitacode'));

  let result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.filter((agent) => agent.name === 'duplicate').length, 1);
  assert.equal(getAgent('duplicate', result.value)?.description, 'project bitacode');

  // Without the first project root, the second project root still wins over user.
  await fs.rm(path.join(cwd, '.bitacode', 'agents', 'duplicate.md'));
  result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getAgent('duplicate', result.value)?.description, 'project agents');
});

test('invalid agent files are skipped with warnings and collected errors', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const warnings = collectWarnings(t);
  const root = path.join(cwd, '.bitacode', 'agents');

  await writeFile(path.join(root, 'valid.md'), agentDoc('valid', '', 'Valid body.'));
  await writeFile(path.join(root, 'no-description.md'), '---\nname: no-description\n---\n\nBody.\n');
  await writeFile(path.join(root, 'Bad Name.md'), agentDoc('Bad Name'));
  await writeFile(path.join(root, 'broken-yaml.md'), '---\nname: broken\ndescription: [unterminated\n---\n\nBody.\n');
  await writeFile(path.join(root, 'bad-approval.md'), agentDoc('bad-approval', 'approval: sandbox\n'));
  await writeFile(path.join(root, 'bad-tools.md'), agentDoc('bad-tools', 'tools: 42\n'));

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(names(result.value), ['build', 'plan', 'general', 'valid']);
  assert.equal(result.errors?.length, 5);
  assert.ok(warnings.some((message) => message.includes('Skipping invalid agent')));
});

test('frontmatter supports string tool lists, model/provider, CRLF and empty bodies', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const root = path.join(cwd, '.bitacode', 'agents');

  await writeFile(path.join(root, 'researcher.md'), agentDoc(
    'researcher',
    'model: gpt-4o\nprovider: openai\ntools: read_file, glob, search_files\ndenyTools:\n  - glob\napproval: auto\n',
    'Use read-only tools.'
  ));
  await writeFile(
    path.join(root, 'windows.md'),
    '---\r\nname: windows\r\ndescription: CRLF frontmatter\r\n---\r\n\r\nLine one.\r\nLine two.\r\n'
  );
  await writeFile(path.join(root, 'compact.md'), '---\nname: compact\ndescription: No trailing newline\n---');

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.errors?.length, 0);

  const researcher = getAgent('researcher', result.value);
  assert.deepEqual(researcher?.tools, ['read_file', 'glob', 'search_files']);
  assert.deepEqual(researcher?.denyTools, ['glob']);
  assert.equal(researcher?.model, 'gpt-4o');
  assert.equal(researcher?.provider, 'openai');
  assert.equal(researcher?.approval, 'auto');
  assert.equal(getAgent('windows', result.value)?.prompt, 'Line one.\r\nLine two.');
  assert.equal(getAgent('compact', result.value)?.prompt, '');
});

test('agents with an oversized prompt are skipped', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const warnings = collectWarnings(t);
  await writeFile(
    path.join(cwd, '.bitacode', 'agents', 'huge.md'),
    agentDoc('huge', '', 'x'.repeat(32 * 1024 + 1))
  );

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getAgent('huge', result.value), undefined);
  assert.equal(result.errors?.length, 1);
  assert.match(result.errors![0], /character limit/);
  assert.ok(warnings.some((message) => message.includes('Skipping invalid agent')));
});

test('files larger than 256 KB are skipped', async (t) => {
  const { cwd, home } = await tempDirs(t);
  await writeFile(
    path.join(cwd, '.bitacode', 'agents', 'oversized.md'),
    agentDoc('oversized', '', 'y'.repeat(256 * 1024))
  );

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getAgent('oversized', result.value), undefined);
  assert.equal(result.errors?.length, 1);
  assert.match(result.errors![0], /limit 262144/);
});

test('dotfiles, non-markdown files and escaping symlinks are skipped', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const warnings = collectWarnings(t);
  const root = path.join(cwd, '.bitacode', 'agents');
  const outside = path.join(home, 'outside.md');
  await writeFile(outside, agentDoc('escape', '', 'Outside body.'));
  await writeFile(path.join(root, '.hidden.md'), agentDoc('hidden'));
  await writeFile(path.join(root, 'notes.txt'), agentDoc('notes'));
  await writeFile(path.join(root, 'real.md'), agentDoc('real'));
  await fs.symlink(path.join(root, 'real.md'), path.join(root, 'linked.md'));
  await fs.symlink(outside, path.join(root, 'escape.md'));

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(names(result.value).sort(), ['build', 'general', 'linked', 'plan', 'real']);
  assert.equal(result.errors?.length, 1);
  assert.match(result.errors![0], /symlink escapes agent root/);
  assert.ok(warnings.some((message) => message.includes('symlink escapes agent root')));
});

test('discovery stops after 64 agent files', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const warnings = collectWarnings(t);
  const root = path.join(cwd, '.bitacode', 'agents');
  for (let i = 0; i < 70; i++) {
    await writeFile(path.join(root, `agent-${i}.md`), agentDoc(`agent-${i}`));
  }

  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length - BUILTIN_AGENTS.length, 64);
  assert.match(result.errors!.join('\n'), /64 file limit/);
  assert.ok(warnings.some((message) => message.includes('64 file limit')));
});

test('getAgent looks up exact names and returns undefined for unknown names', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const agents = result.value;

  assert.equal(getAgent('plan', agents)?.name, 'plan');
  assert.equal(getAgent(' PLAN ', agents), undefined);
  assert.equal(getAgent('missing', agents), undefined);
  assert.equal(getAgent('', agents), undefined);
  assert.equal(getAgent('build', BUILTIN_AGENTS)?.source, 'builtin');
});

test('resolveAgentSelection falls back to build for missing or unknown names', async (t) => {
  const { cwd, home } = await tempDirs(t);
  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const agents = result.value;

  assert.equal(resolveAgentSelection(undefined, agents).name, 'build');
  assert.equal(resolveAgentSelection('', agents).name, 'build');
  assert.equal(resolveAgentSelection('do-not-exist', agents).name, 'build');
  assert.equal(resolveAgentSelection('general', agents).name, 'general');
  // Even a list without `build` must resolve to the built-in default.
  assert.equal(resolveAgentSelection('missing', [agents[1]]).name, 'build');
});

test('applyAgentTools applies allowlist then denylist and preserves order', () => {
  const agent = {
    ...BUILTIN_AGENTS[0],
    tools: ['read_file', 'glob', 'bash', 'edit_file'],
    denyTools: ['bash', 'edit_file'],
  };
  const tools = ['bash', 'glob', 'grep', 'read_file', 'edit_file'];
  assert.deepEqual(applyAgentTools(agent, tools), ['glob', 'read_file']);
  assert.deepEqual(applyAgentTools(BUILTIN_AGENTS[0], tools), tools);
  assert.deepEqual(applyAgentTools(agent, []), []);
});

test('applyAgentTools never empties a non-empty tool list', () => {
  const noAllow = { ...BUILTIN_AGENTS[0], tools: [] as string[] };
  const allDenied = { ...BUILTIN_AGENTS[0], denyTools: ['bash', 'glob'] };
  assert.deepEqual(applyAgentTools(noAllow, ['bash', 'glob']), ['bash']);
  assert.deepEqual(applyAgentTools(allDenied, ['bash', 'glob']), ['bash']);
});

test('the plan builtin is read-only and requires manual approval', () => {
  const plan = getAgent('plan', BUILTIN_AGENTS)!;
  assert.equal(plan.approval, 'manual');
  assert.deepEqual(applyAgentTools(plan, ['bash', 'read_file', 'diff', 'edit_file']), ['read_file', 'diff']);
});

test('renderAgentCatalog lists names, descriptions and sources without prompts', async (t) => {
  const { cwd, home } = await tempDirs(t);
  await writeFile(
    path.join(cwd, '.bitacode', 'agents', 'reviewer.md'),
    agentDoc('reviewer', '', 'SECRET PROMPT TEXT')
  );
  const result = discoverAgents({ cwd, home });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const catalog = renderAgentCatalog(result.value);
  assert.match(catalog, /^- build:/m);
  assert.match(catalog, /reviewer: reviewer agent \[source: /);
  assert.match(catalog, new RegExp(path.basename(path.join(cwd, '.bitacode', 'agents', 'reviewer.md'))));
  assert.doesNotMatch(catalog, /SECRET PROMPT TEXT/);
  assert.equal(renderAgentCatalog([]), '');
});

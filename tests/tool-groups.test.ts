import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_TOOL_GROUPS,
  describeGroups,
  groupForTool,
  parseToolGroups,
  resolveVisibleTools,
  type ToolGroup,
} from '../src/utils/tool-groups.js';

type Tool = { function: { name: string; description: string; parameters: Record<string, unknown> } };

function tool(name: string): Tool {
  return { function: { name, description: name, parameters: {} } };
}

function names(tools: readonly Tool[]): string[] {
  return tools.map((entry) => entry.function.name);
}

// Every tool registered in src/tools/index.ts, plus loop-level tools and
// dispatcher aliases. Expected group is spelled out so an unmapped tool in a
// non-core group fails the coverage test below.
const BUILT_IN: ReadonlyArray<readonly [string, ToolGroup]> = [
  ['read_file', 'core'],
  ['read_lines', 'files'],
  ['write_file', 'files'],
  ['edit_file', 'files'],
  ['list_directory', 'core'],
  ['search_files', 'core'],
  ['glob', 'core'],
  ['bash', 'process'],
  ['todo_read', 'core'],
  ['todo_write', 'core'],
  ['webfetch', 'web'],
  ['ask_user', 'core'],
  ['apply_patch', 'files'],
  ['start_process', 'process'],
  ['poll_process', 'process'],
  ['write_process_stdin', 'process'],
  ['stop_process', 'process'],
  ['git_status', 'process'],
  ['git_diff', 'process'],
  ['git_add', 'process'],
  ['git_commit', 'process'],
  ['git_stash', 'process'],
  ['web_search', 'web'],
  ['read_subagent', 'agents'],
  ['multiedit', 'files'],
  ['delete', 'files'],
  ['rename', 'files'],
  ['move', 'files'],
  ['copy', 'files'],
  ['mkdir', 'files'],
  ['stat', 'files'],
  ['diff', 'files'],
  ['env', 'process'],
  ['which', 'process'],
  ['command_exists', 'process'],
  ['watch', 'process'],
  ['kill', 'process'],
  ['background', 'process'],
  ['codesearch', 'files'],
  ['search_docs', 'web'],
  ['find_symbol', 'files'],
  ['search_history', 'web'],
  ['plan', 'agents'],
  ['parallel', 'agents'],
  ['agent_status', 'agents'],
  ['agent_message', 'agents'],
  ['team_post', 'agents'],
  ['team_read', 'agents'],
  ['team_list', 'agents'],
  ['team_spawn', 'agents'],
  ['agent_define', 'agents'],
  ['task_result', 'agents'],
  ['notify', 'agents'],
  ['progress', 'agents'],
  ['open_url', 'web'],
  ['undo', 'files'],
  ['read_image', 'files'],
  ['go_to_definition', 'files'],
  ['find_references', 'files'],
  ['diagnostics', 'files'],
  ['update_working_checkpoint', 'core'],
  ['memory_add', 'core'],
  ['memory_list', 'core'],
  ['memory_forget', 'core'],
  ['verify_project', 'process'],
  // Loop-level tools and dispatcher aliases.
  ['sub_agent', 'agents'],
  ['activate_skill', 'agents'],
  ['grep', 'core'],
  ['search_text', 'core'],
  ['list', 'core'],
  ['find_file', 'core'],
  ['shell', 'process'],
  ['terminal', 'process'],
  ['run', 'process'],
  ['fetch_url', 'web'],
  ['websearch', 'web'],
  ['task', 'agents'],
  ['subagent', 'agents'],
  ['question', 'core'],
  ['confirm', 'core'],
  ['select', 'core'],
  ['input', 'core'],
  ['approval', 'core'],
];

test('parseToolGroups splits commas/spaces, lowercases and preserves first-seen order', () => {
  assert.deepEqual(parseToolGroups('core,files,web'), ['core', 'files', 'web']);
  assert.deepEqual(parseToolGroups(' WEB , CORE  files '), ['web', 'core', 'files']);
  assert.deepEqual(parseToolGroups('files, core, files, web'), ['files', 'core', 'web']);
});

test('parseToolGroups expands `all` to every concrete group and dedupes', () => {
  assert.deepEqual(parseToolGroups('all'), [...ALL_TOOL_GROUPS]);
  assert.deepEqual(parseToolGroups('web,all,core'), ['web', 'core', 'files', 'process', 'agents']);
  assert.deepEqual(parseToolGroups('all,agents,all'), [...ALL_TOOL_GROUPS]);
  assert.ok(ALL_TOOL_GROUPS.includes('core'));
  assert.ok(!ALL_TOOL_GROUPS.includes('all'), '`all` is a meta-group, not a selectable group');
});

test('parseToolGroups ignores unknown tokens and defaults safely', () => {
  assert.deepEqual(parseToolGroups('bogus, files, ???'), ['files']);
  assert.deepEqual(parseToolGroups('bogus!!!'), ['core']);
  assert.deepEqual(parseToolGroups(''), ['core']);
  assert.deepEqual(parseToolGroups('   '), ['core']);
  assert.deepEqual(parseToolGroups(undefined), ['core']);
});

test('parseToolGroups never throws on malformed input', () => {
  for (const bad of [null, 42, {}, ['core'], Symbol('x')] as unknown[]) {
    assert.doesNotThrow(() => parseToolGroups(bad as string | undefined));
    assert.deepEqual(parseToolGroups(bad as string | undefined), ['core']);
  }
});

test('parseToolGroups accepts documented aliases', () => {
  assert.deepEqual(parseToolGroups('default'), ['core']);
  assert.deepEqual(parseToolGroups('agent, subagent, file'), ['agents', 'files']);
  assert.deepEqual(parseToolGroups('*'), [...ALL_TOOL_GROUPS]);
  assert.deepEqual(parseToolGroups('everything'), [...ALL_TOOL_GROUPS]);
  assert.deepEqual(parseToolGroups('system'), ['process']);
});

test('groupForTool covers every built-in tool name with its expected group', () => {
  for (const [name, expected] of BUILT_IN) {
    assert.equal(groupForTool(name), expected, `group for ${name}`);
  }
});

test('groupForTool fails closed for unknown, dynamic and prototype-like names', () => {
  assert.equal(groupForTool('mcp__github__issues'), 'core');
  assert.equal(groupForTool('brand_new_tool'), 'core');
  assert.equal(groupForTool(''), 'core');
  assert.equal(groupForTool('toString'), 'core');
  assert.equal(groupForTool('__proto__'), 'core');
});

test('resolveVisibleTools filters by group while preserving order and identity', () => {
  const all = [tool('read_file'), tool('bash'), tool('web_search'), tool('git_diff')];
  const core = resolveVisibleTools(all, { groups: ['core'] });
  assert.deepEqual(names(core), ['read_file']);
  assert.equal(core[0], all[0]);

  const mixed = resolveVisibleTools(all, { groups: ['core', 'web'] });
  assert.deepEqual(names(mixed), ['read_file', 'web_search']);
  assert.equal(mixed[0], all[0]);
  assert.equal(mixed[1], all[2]);
});

test('alwaysVisible keeps named tools outside the selected groups', () => {
  const all = [tool('read_file'), tool('bash'), tool('web_search'), tool('git_diff')];
  const visible = resolveVisibleTools(all, {
    groups: ['core'],
    alwaysVisible: ['git_diff', 'web_search', 'not_registered'],
  });
  assert.deepEqual(names(visible), ['read_file', 'web_search', 'git_diff']);
  assert.equal(visible[1], all[2]);
  assert.equal(visible[2], all[3]);
});

test('no groups, empty groups, junk groups and `all` keep every tool', () => {
  const all = [tool('read_file'), tool('bash'), tool('web_search')];
  assert.deepEqual(names(resolveVisibleTools(all)), names(all));
  assert.deepEqual(names(resolveVisibleTools(all, { groups: [] })), names(all));
  assert.deepEqual(names(resolveVisibleTools(all, { groups: ['all'] })), names(all));
  assert.deepEqual(
    names(resolveVisibleTools(all, { groups: ['nonsense' as ToolGroup] })),
    names(all)
  );
});

test('resolveVisibleTools never hides every tool and handles duplicate entries', () => {
  const files = [tool('read_file'), tool('write_file')];
  assert.deepEqual(names(resolveVisibleTools(files, { groups: ['agents'] })), names(files));
  assert.deepEqual(resolveVisibleTools([], { groups: ['core'] }), []);

  const dupes = [tool('read_file'), tool('read_file')];
  assert.deepEqual(names(resolveVisibleTools(dupes, { groups: ['core', 'web', 'core'] })), names(dupes));
});

test('resolveVisibleTools never throws on malformed tools or options', () => {
  const all = [tool('read_file'), tool('bash')];
  const malformed = [{ function: {} }, null, undefined] as unknown as Tool[];
  assert.doesNotThrow(() => resolveVisibleTools(malformed, { groups: ['core'] }));
  assert.doesNotThrow(() => resolveVisibleTools(null as unknown as Tool[], { groups: ['core'] }));
  assert.doesNotThrow(() => resolveVisibleTools(all, null as unknown as { groups?: ToolGroup[] }));
  assert.deepEqual(names(resolveVisibleTools(all, null as unknown as { groups?: ToolGroup[] })), names(all));
});

test('describeGroups renders short strings and degrades safely', () => {
  assert.equal(describeGroups(['core', 'files']), 'core, files');
  assert.equal(describeGroups(['web', 'core']), 'web, core');
  assert.equal(describeGroups(['all']), 'all tools');
  assert.equal(describeGroups([...ALL_TOOL_GROUPS]), 'all tools');
  assert.equal(describeGroups([]), 'core');
  assert.equal(describeGroups(['nonsense' as ToolGroup]), 'core');
  assert.equal(describeGroups(null as unknown as ToolGroup[]), 'core');
  assert.doesNotThrow(() => describeGroups(Symbol('x') as unknown as ToolGroup[]));
});

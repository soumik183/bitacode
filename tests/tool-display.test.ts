import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendlyToolLabel,
  formatToolActivity,
  formatSubAgentActivity,
  formatToolLabel,
} from '../src/utils/tool-display.js';

type Args = Record<string, unknown>;

// tool → args → exact `formatToolLabel` output. Covers file ops, search,
// processes, todos, git, control, memory, team/agent, dynamic and unknown tools.
const CASES: Array<[string, Args, string]> = [
  ['read_file', { file_path: 'src/a.ts' }, 'Read file · src/a.ts'],
  ['write_file', { file_path: 'src/a.ts' }, 'Write file · src/a.ts'],
  ['edit_file', { file_path: 'src/a.ts' }, 'Edit file · src/a.ts'],
  ['multiedit', { edits: [{ file_path: 'src/a.ts' }] }, 'Multi edit · src/a.ts'],
  ['apply_patch', { patch: '*** Begin Patch' }, 'Apply patch'],
  ['delete', { file_path: 'src/a.ts' }, 'Delete file · src/a.ts'],
  ['rename', { source: 'a.ts', destination: 'b.ts' }, 'Rename file · a.ts → b.ts'],
  ['move', { source: 'a.ts', destination: 'b.ts' }, 'Move file · a.ts → b.ts'],
  ['copy', { source: 'a.ts', destination: 'b.ts' }, 'Copy file · a.ts → b.ts'],
  ['mkdir', { directory_path: 'src/new' }, 'Make directory · src/new'],
  ['stat', { file_path: 'src/a.ts' }, 'File info · src/a.ts'],
  ['diff', { source: 'a.ts', destination: 'b.ts' }, 'Diff · a.ts → b.ts'],
  ['read_image', { file_path: 'img.png' }, 'Read image · img.png'],
  ['list_directory', { directory_path: 'src' }, 'List files · src'],
  ['search_files', { search_term: 'bug' }, 'Search files · "bug"'],
  ['glob', { pattern: 'src/**/*.ts' }, 'Find files · "src/**/*.ts"'],
  ['codesearch', { query: 'foo' }, 'Code search · "foo"'],
  ['find_symbol', { symbol: 'foo' }, 'Find symbol · "foo"'],
  ['find_references', { symbol: 'foo' }, 'Find references · "foo"'],
  ['go_to_definition', { symbol: 'foo' }, 'Go to definition · "foo"'],
  ['diagnostics', { directory_path: 'src' }, 'Diagnostics · src'],
  ['search_docs', { query: 'react' }, 'Search docs · "react"'],
  ['search_history', { query: 'git' }, 'Search history · "git"'],
  ['webfetch', { url: 'https://example.com/a' }, 'Fetch URL · example.com'],
  ['open_url', { url: 'https://example.com/a' }, 'Open URL · example.com'],
  ['web_search', { query: 'bug' }, 'Web search · "bug"'],
  ['bash', { command: 'npm run build' }, 'Run command · npm run build'],
  ['start_process', { command: 'npm run dev' }, 'Start process · npm run dev'],
  ['poll_process', { id: '3' }, 'Poll process · 3'],
  ['write_process_stdin', { id: '3', data: 'y' }, 'Write to process · 3'],
  ['stop_process', { id: '3' }, 'Stop process · 3'],
  ['kill', { pid: '42' }, 'Kill process · 42'],
  ['background', { command: 'sleep 5' }, 'Background command · sleep 5'],
  ['watch', { path: 'src/a.ts' }, 'Watch · src/a.ts'],
  ['env', { name: 'HOME' }, 'Read env · HOME'],
  ['which', { name: 'node' }, 'Which command · node'],
  ['command_exists', { name: 'node' }, 'Check command · node'],
  ['todo_read', {}, 'Read todos'],
  [
    'todo_write',
    { todos: [{ id: '1', content: 'a', status: 'pending' }, { id: '2', content: 'b', status: 'pending' }] },
    'Todo add · 2 items',
  ],
  [
    'todo_write',
    { todos: [{ id: '1', content: 'a', status: 'pending' }, { id: '2', content: 'b', status: 'completed' }] },
    'Todo update · 2 items',
  ],
  ['todo_write', { todos: [{ id: '1', content: 'a', status: 'completed' }] }, 'Todo complete · 1 done'],
  [
    'todo_write',
    { todos: [{ id: '1', content: 'a', status: 'pending' }], from_hint: 'delete' },
    'Todo delete · 1 items',
  ],
  ['git_status', { short: true }, 'Git status · short'],
  ['git_diff', { staged: true }, 'Git diff · staged'],
  ['git_add', { paths: ['a.ts', 'b.ts'] }, 'Git add · a.ts, b.ts'],
  ['git_commit', { message: 'fix bug' }, 'Git commit · fix bug'],
  ['git_stash', { action: 'pop' }, 'Git stash · pop'],
  ['plan', {}, 'Plan'],
  ['parallel', { calls: [{}, {}] }, 'Parallel calls · 2 calls'],
  ['notify', { message: 'done' }, 'Notify · done'],
  ['progress', { percent: 50 }, 'Progress · 50%'],
  ['verify_project', {}, 'Verify project'],
  ['undo', { id: 'abc' }, 'Undo change · abc'],
  ['update_working_checkpoint', { content: 'note' }, 'Save checkpoint · note'],
  ['memory_add', { text: 'remember me' }, 'Remember · remember me'],
  ['memory_list', {}, 'List memory'],
  ['memory_forget', { target: 'old note' }, 'Forget memory · old note'],
  ['team_list', {}, 'Team list'],
  ['team_post', { body: 'hello' }, 'Team post · hello'],
  ['team_read', {}, 'Team read'],
  ['team_spawn', { name: 'researcher' }, 'Spawn agent · researcher'],
  ['agent_define', { name: 'reviewer' }, 'Define agent · reviewer'],
  ['agent_status', { id: '42' }, 'Agent status · 42'],
  ['agent_message', { to: 'researcher' }, 'Agent message · researcher'],
  ['task_result', { task_id: '7' }, 'Task result · 7'],
  ['ask_user', { question: 'Proceed?' }, 'Ask question · Proceed?'],
  ['read_subagent', { id: 's1' }, 'Read subagent · s1'],
  ['activate_skill', { skill: 'pdf' }, 'Activate skill · pdf'],
  ['sub_agent', { agent_type: 'researcher' }, 'Sub-agent · researcher'],
  ['sub_agent', { tasks: [{}, {}] }, 'Sub-agent · 2 tasks'],
  ['mcp__github__issues', {}, 'MCP tool · issues'],
  ['unknown_tool', { foo: 'bar' }, 'Unknown Tool · bar'],
];

test('friendly labels cover every tool with a concise title and short hint', () => {
  for (const [name, args, expected] of CASES) {
    assert.equal(formatToolLabel(name, args), expected, `label for ${name}`);
  }
});

test('formatToolLabel is title plus an optional " · hint" and never leaks snake_case', () => {
  for (const [name, args] of CASES) {
    const { title, hint } = friendlyToolLabel(name, args);
    assert.ok(title.length > 0, `${name} has a title`);
    assert.doesNotMatch(title, /_/, `${name} title has no snake_case`);
    assert.equal(formatToolLabel(name, args), hint ? `${title} · ${hint}` : title);
    assert.doesNotMatch(formatToolLabel(name, args), /[\r\n]/, 'hint stays on one line');
    assert.ok((hint ?? '').length <= 40, `${name} hint stays short`);
    assert.doesNotMatch(formatToolLabel(name, args), /undefined|\[object Object\]/);
  }
});

test('args may be a JSON string; malformed strings never throw', () => {
  assert.equal(formatToolLabel('read_file', '{"file_path":"src/b.ts"}'), 'Read file · src/b.ts');
  assert.equal(formatToolLabel('read_file', '{not json'), 'Read file');
  assert.equal(formatToolLabel('web_search', '{"query":"bug"}'), 'Web search · "bug"');
  assert.doesNotThrow(() => formatToolLabel('mcp__x__y', '{"broken"'));
  assert.equal(formatToolLabel('some_custom_tool', undefined), 'Some Custom Tool');
});

test('every registered tool gets a friendly, non-empty title', async () => {
  const { tools } = await import('../src/tools/index.js');
  const names = [...tools.map((tool) => tool.function.name), 'sub_agent', 'activate_skill', 'mcp__x__y'];
  for (const name of names) {
    const label = friendlyToolLabel(name, undefined);
    assert.ok(label.title.length > 0, `${name} has a title`);
    assert.doesNotMatch(label.title, /_/, `${name} title has no snake_case`);
  }
});

test('existing formatToolActivity / formatSubAgentActivity behavior is unchanged', () => {
  assert.equal(formatToolActivity('read_file', { file_path: 'src/a.ts' }), 'read_file src/a.ts');
  assert.equal(formatToolActivity('bash', { command: 'npm run build test' }), 'bash npm run build...');
  assert.equal(formatToolActivity('todo_write', { todos: [1, 2, 3] }), 'todo_write 3 task(s)');
  assert.equal(formatToolActivity('unknown', { foo: 'bar' }), 'unknown bar');
  assert.equal(formatToolActivity('read_file'), 'read_file');
  assert.equal(formatToolActivity('webfetch', { url: 'not a url' }), 'webfetch not a url');
  assert.equal(formatSubAgentActivity('read_file', { file_path: 'src/a.ts' }), 'Sub-agent read file: src/a.ts');
  assert.equal(formatSubAgentActivity('read_file'), 'Sub-agent running read_file...');
});

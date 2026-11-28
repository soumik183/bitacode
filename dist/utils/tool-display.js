// Extract the most meaningful detail from tool args based on tool type
export function extractToolDetail(tool, args) {
    switch (tool) {
        case 'read_file':
        case 'write_file':
        case 'edit_file':
            return typeof args.file_path === 'string' ? args.file_path : '';
        case 'list_directory':
            return typeof args.directory_path === 'string' ? args.directory_path : '(current)';
        case 'search_files':
            return typeof args.search_term === 'string' ? `"${args.search_term}"` : '';
        case 'glob':
            return typeof args.pattern === 'string' ? args.pattern : '';
        case 'bash': {
            if (typeof args.command !== 'string')
                return '';
            const parts = args.command.split(/\s+/);
            return parts.slice(0, 3).join(' ') + (parts.length > 3 ? '...' : '');
        }
        case 'todo_write':
            if (!Array.isArray(args.todos))
                return '';
            return `${args.todos.length} task${args.todos.length === 1 ? '' : 's'}`;
        case 'todo_read':
            return 'read';
        case 'webfetch': {
            if (typeof args.url !== 'string' || args.url.length === 0)
                return '';
            try {
                return new URL(args.url).hostname;
            }
            catch {
                return args.url.slice(0, 40);
            }
        }
        case 'sub_agent':
            return 'nested task...';
        default: {
            // Fallback: first string argument, truncated to 30 chars
            const firstEntry = Object.entries(args).find(([, v]) => typeof v === 'string');
            if (!firstEntry)
                return '';
            const value = String(firstEntry[1]);
            return value.length > 30 ? value.slice(0, 30) + '...' : value;
        }
    }
}
// Format sub-agent activity: "Sub-agent read_file: src/App.tsx"
export function formatSubAgentActivity(tool, args) {
    if (!args || typeof args !== 'object') {
        return `Sub-agent running ${tool}...`;
    }
    const detail = extractToolDetail(tool, args);
    if (!detail) {
        return `Sub-agent running ${tool}...`;
    }
    return `Sub-agent ${tool.replace(/_/g, ' ')}: ${detail}`;
}
// Format tool activity: "read_file src/App.tsx"
export function formatToolActivity(tool, args) {
    if (!args || typeof args !== 'object') {
        return tool;
    }
    const detail = extractToolDetail(tool, args);
    return detail ? `${tool} ${detail}` : tool;
}
const MAX_HINT = 40;
/** Args arrive either as an object or as a JSON string from the model. */
function toArgs(args) {
    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Malformed JSON is not fatal — the label just has no hint.
        }
        return {};
    }
    if (args && typeof args === 'object' && !Array.isArray(args))
        return args;
    return {};
}
/** First non-empty string/number among `keys`. */
function str(args, ...keys) {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
        if (typeof value === 'number' && Number.isFinite(value))
            return String(value);
    }
    return '';
}
/** One-line, bounded hint text. */
function short(value, max = MAX_HINT) {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!clean)
        return '';
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
function basename(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}
function pathHint(args) {
    const raw = str(args, 'file_path', 'path', 'filename', 'file', 'source', 'destination', 'directory_path', 'dir', 'directory');
    if (!raw)
        return '';
    const relative = raw.replace(/^\.\//, '');
    return short(relative.length > MAX_HINT ? basename(relative) : relative);
}
function pairedPathHint(args) {
    const source = str(args, 'source', 'file_path', 'path');
    const destination = str(args, 'destination');
    if (source && destination) {
        const from = source.length > 18 ? basename(source) : source;
        const to = destination.length > 18 ? basename(destination) : destination;
        return short(`${from} → ${to}`);
    }
    return pathHint(args);
}
function quotedHint(args) {
    const value = str(args, 'query', 'search_term', 'pattern', 'symbol', 'text', 'q', 'name', 'variable');
    const clean = short(value, MAX_HINT - 2);
    return clean ? `"${clean}"` : '';
}
function urlHint(args) {
    const url = str(args, 'url', 'link');
    if (!url)
        return '';
    try {
        return short(new URL(url).hostname);
    }
    catch {
        return short(url);
    }
}
function commandHint(args) {
    const command = str(args, 'command', 'cmd');
    if (!command)
        return '';
    return short(command.split(/\s+/).filter(Boolean).slice(0, 4).join(' '));
}
function idHint(args, ...keys) {
    return short(str(args, 'id', 'pid', 'task_id', 'session_id', 'name', ...keys));
}
/** Human, Title Case title for a tool name, with no snake_case. */
function humanize(name) {
    const clean = String(name ?? '').replace(/[_-]+/g, ' ').trim();
    return clean.replace(/\b\w/g, (char) => char.toUpperCase());
}
/** Simple, fixed titles for tools whose hint needs no special handling. */
const TITLES = {
    read_file: 'Read file',
    write_file: 'Write file',
    edit_file: 'Edit file',
    multiedit: 'Multi edit',
    multi_edit: 'Multi edit',
    apply_patch: 'Apply patch',
    delete: 'Delete file',
    rename: 'Rename file',
    move: 'Move file',
    copy: 'Copy file',
    mkdir: 'Make directory',
    stat: 'File info',
    diff: 'Diff',
    read_image: 'Read image',
    list_directory: 'List files',
    list: 'List files',
    search_files: 'Search files',
    grep: 'Search files',
    search_text: 'Search files',
    glob: 'Find files',
    find_file: 'Find files',
    codesearch: 'Code search',
    find_symbol: 'Find symbol',
    find_references: 'Find references',
    go_to_definition: 'Go to definition',
    diagnostics: 'Diagnostics',
    search_docs: 'Search docs',
    search_history: 'Search history',
    webfetch: 'Fetch URL',
    fetch_url: 'Fetch URL',
    open_url: 'Open URL',
    web_search: 'Web search',
    websearch: 'Web search',
    bash: 'Run command',
    shell: 'Run command',
    terminal: 'Run command',
    run: 'Run command',
    start_process: 'Start process',
    poll_process: 'Poll process',
    write_process_stdin: 'Write to process',
    stop_process: 'Stop process',
    kill: 'Kill process',
    background: 'Background command',
    watch: 'Watch',
    env: 'Read env',
    which: 'Which command',
    command_exists: 'Check command',
    todo_read: 'Read todos',
    git_status: 'Git status',
    git_diff: 'Git diff',
    git_add: 'Git add',
    git_commit: 'Git commit',
    git_stash: 'Git stash',
    plan: 'Plan',
    parallel: 'Parallel calls',
    notify: 'Notify',
    progress: 'Progress',
    verify_project: 'Verify project',
    undo: 'Undo change',
    update_working_checkpoint: 'Save checkpoint',
    memory_add: 'Remember',
    memory_list: 'List memory',
    memory_forget: 'Forget memory',
    team_list: 'Team list',
    team_post: 'Team post',
    team_read: 'Team read',
    team_spawn: 'Spawn agent',
    agent_define: 'Define agent',
    agent_status: 'Agent status',
    agent_message: 'Agent message',
    task_result: 'Task result',
    ask_user: 'Ask question',
    question: 'Ask question',
    confirm: 'Ask question',
    select: 'Ask question',
    input: 'Ask question',
    approval: 'Ask question',
    read_subagent: 'Read subagent',
    activate_skill: 'Activate skill',
    sub_agent: 'Sub-agent',
    subagent: 'Sub-agent',
    task: 'Sub-agent',
};
/** Heuristic: without prior state, infer todo intent from status/content signals. */
function todoLabel(args) {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    const n = todos.length;
    let completed = 0;
    let content = '';
    for (const todo of todos) {
        if (todo && typeof todo === 'object') {
            const item = todo;
            if (item.status === 'completed')
                completed += 1;
            if (typeof item.content === 'string')
                content += `${item.content} `;
            if (typeof item.status === 'string')
                content += `${item.status} `;
        }
    }
    const signal = `${str(args, 'from_hint', 'hint')} ${content}`.toLowerCase();
    let title;
    if (/\b(delete|remove)\b/.test(signal))
        title = 'Todo delete';
    else if (n > 0 && completed === n)
        title = 'Todo complete';
    else if (completed > 0)
        title = 'Todo update';
    else
        title = 'Todo add';
    return { title, hint: title === 'Todo complete' ? `${completed} done` : `${n} item${n === 1 ? '' : 's'}` };
}
function hintFor(tool, args) {
    switch (tool) {
        case 'read_file':
        case 'write_file':
        case 'edit_file':
        case 'delete':
        case 'stat':
        case 'read_image':
        case 'mkdir':
        case 'list_directory':
        case 'list':
        case 'diagnostics':
        case 'watch':
            return pathHint(args);
        case 'rename':
        case 'move':
        case 'copy':
        case 'diff':
            return pairedPathHint(args);
        case 'multiedit':
        case 'multi_edit': {
            const edits = args.edits;
            if (Array.isArray(edits) && edits.length > 0) {
                const first = edits[0];
                const file = first && typeof first === 'object' ? str(first, 'file_path', 'path') : '';
                return short(file || `${edits.length} edits`);
            }
            return pathHint(args);
        }
        case 'apply_patch':
            return pathHint(args);
        case 'search_files':
        case 'grep':
        case 'search_text':
        case 'codesearch':
        case 'search_docs':
        case 'search_history':
        case 'web_search':
        case 'websearch': {
            const queries = args.queries;
            const first = Array.isArray(queries) && typeof queries[0] === 'string' ? queries[0] : '';
            const value = first || str(args, 'query', 'search_term', 'q');
            const clean = short(value, MAX_HINT - 2);
            return clean ? `"${clean}"` : '';
        }
        case 'glob':
        case 'find_file':
        case 'find_symbol':
        case 'find_references':
        case 'go_to_definition':
            return quotedHint(args);
        case 'webfetch':
        case 'fetch_url':
        case 'open_url':
            return urlHint(args);
        case 'bash':
        case 'shell':
        case 'terminal':
        case 'run':
        case 'start_process':
        case 'background':
            return commandHint(args);
        case 'poll_process':
        case 'stop_process':
        case 'write_process_stdin':
            return idHint(args);
        case 'kill':
            return idHint(args, 'pid');
        case 'env':
        case 'which':
        case 'command_exists':
            return short(str(args, 'name', 'variable'));
        case 'git_status':
            return args.short ? 'short' : '';
        case 'git_diff':
            return args.staged ? 'staged' : args.stat ? 'stat' : '';
        case 'git_add': {
            const paths = args.paths;
            if (Array.isArray(paths) && paths.length > 0) {
                return short(paths.map((p) => String(p)).join(', '));
            }
            return args.all ? 'all' : short(str(args, 'paths', 'path'));
        }
        case 'git_commit':
            return short(str(args, 'message'));
        case 'git_stash':
            return short(str(args, 'action', 'message'));
        case 'parallel': {
            const calls = args.calls;
            return Array.isArray(calls) ? `${calls.length} calls` : '';
        }
        case 'notify':
            return short(str(args, 'message', 'text'));
        case 'progress': {
            const percent = args.percent;
            if (typeof percent === 'number' && Number.isFinite(percent))
                return `${percent}%`;
            return short(str(args, 'percent', 'message'));
        }
        case 'undo':
            return idHint(args);
        case 'update_working_checkpoint':
            return short(str(args, 'content', 'text'));
        case 'memory_add':
            return short(str(args, 'text', 'content'));
        case 'memory_forget':
            return short(str(args, 'target'));
        case 'team_post':
            return short(str(args, 'body', 'message', 'text', 'channel'));
        case 'team_read':
            return short(str(args, 'channel'));
        case 'team_spawn':
        case 'agent_define':
            return short(str(args, 'name', 'agent_name', 'agent'));
        case 'agent_status':
            return idHint(args);
        case 'agent_message':
            return short(str(args, 'to', 'recipient', 'agent', 'id'));
        case 'task_result':
            return idHint(args, 'task');
        case 'ask_user':
        case 'question':
        case 'confirm':
        case 'select':
        case 'input':
        case 'approval':
            return short(str(args, 'question', 'prompt', 'text'));
        case 'read_subagent':
            return idHint(args, 'session');
        case 'activate_skill':
            return short(str(args, 'skill', 'skill_name', 'name'));
        case 'sub_agent':
        case 'subagent':
        case 'task': {
            const tasks = args.tasks;
            if (Array.isArray(tasks) && tasks.length > 0) {
                return `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
            }
            return short(str(args, 'agent_type', 'agent', 'name') || str(args, 'task', 'prompt'));
        }
        default: {
            // Unknown tool: first short string argument.
            const first = Object.values(args).find((value) => typeof value === 'string' && value.length > 0);
            return first ? short(String(first)) : '';
        }
    }
}
/** Short, human title + optional hint for any tool name and its arguments. */
export function friendlyToolLabel(name, args) {
    const tool = String(name ?? '').trim();
    try {
        const parsed = toArgs(args);
        if (tool.startsWith('mcp__')) {
            const parts = tool.split('__');
            return { title: 'MCP tool', hint: short(parts[parts.length - 1] || 'call') };
        }
        if (tool === 'todo_write')
            return todoLabel(parsed);
        const title = TITLES[tool] ?? humanize(tool);
        const hint = hintFor(tool, parsed);
        return hint ? { title, hint } : { title };
    }
    catch {
        // Never throw on malformed or hostile arguments.
        return { title: humanize(tool) || 'Tool' };
    }
}
/** One-line rendering: `Title` or `Title · hint`. */
export function formatToolLabel(name, args) {
    const { title, hint } = friendlyToolLabel(name, args);
    return hint ? `${title} · ${hint}` : title;
}

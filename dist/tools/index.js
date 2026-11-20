/**
 * Tool registry — collects all tool definitions and provides a dispatcher.
 *
 * Each tool file exports:
 *  - A tool definition (OpenAI function-calling JSON schema)
 *  - A handler function (args) => Promise<string>
 *
 * This file wires them together into a single `tools` array and
 * a `handleToolCall(name, args)` dispatcher.
 */
import { readFileTool, readFile } from './read-file.js';
import { writeFileTool, writeFile } from './write-file.js';
import { editFileTool, editFile } from './edit-file.js';
import { listDirectoryTool, listDirectory } from './list-directory.js';
import { searchFilesTool, searchFiles } from './search-files.js';
import { globTool, globFiles } from './glob.js';
import { bashTool, runBash } from './bash.js';
import { todoReadTool, todoWriteTool, readTodos, writeTodos } from './todo.js';
import { webfetchTool, webfetch } from './webfetch.js';
import { askQuestionTool, askUser, normalizeAskRequest } from './ask.js';
import { applyPatchTool, applyPatch } from './apply-patch.js';
import { startProcessTool, pollProcessTool, writeProcessStdinTool, stopProcessTool, startProcess, pollProcess, writeProcessStdin, stopProcess, } from './process.js';
import { gitStatusTool, gitDiffTool, gitAddTool, gitCommitTool, gitStashTool, gitStatus, gitDiff, gitAdd, gitCommit, gitStash, } from './git.js';
import { webSearchTool, webSearch } from './web-search.js';
import { readSubagentTool, readSubagent } from './subagent-session.js';
import leven from 'leven';
// File operations (one tool per file)
import { multieditTool, multiedit } from './multiedit.js';
import { deleteTool, deletePath } from './delete.js';
import { renameTool, renamePath } from './rename.js';
import { moveTool, movePath } from './move.js';
import { copyTool, copyPath } from './copy.js';
import { mkdirTool, makeDirectory } from './mkdir.js';
import { statTool, statPath } from './stat.js';
import { diffTool, diffFiles } from './diff.js';
// System & process utilities
import { envTool, readEnv } from './env.js';
import { whichTool, which } from './which.js';
import { commandExistsTool, commandExists } from './command-exists.js';
import { watchTool, watch } from './watch.js';
import { killTool, kill } from './kill.js';
import { backgroundTool, background } from './background.js';
// Search & discovery
import { codesearchTool, codesearch } from './codesearch.js';
import { searchDocsTool, searchDocs } from './search-docs.js';
import { findSymbolTool, findSymbol } from './find-symbol.js';
import { searchHistoryTool, searchHistory } from './search-history.js';
// Task coordination & control
import { planTool, plan } from './plan.js';
import { parallelTool, runParallel, setParallelExecutor } from './parallel.js';
import { agentStatusTool, agentStatus } from './agent-status.js';
import { agentMessageTool, agentMessage } from './agent-message.js';
import { teamPostTool, teamReadTool, teamListTool, teamSpawnTool, agentDefineTool, teamPost, teamRead, teamList, teamSpawn, agentDefine, } from './team.js';
import { taskResultTool, taskResult } from './task-result.js';
import { notifyTool, notify } from './notify.js';
import { progressTool, progress } from './progress.js';
import { openUrlTool, openUrl } from './open-url.js';
import { undoTool, undo } from './undo.js';
import { readImageTool, readImage } from './image-input.js';
import { goToDefinitionTool, goToDefinition, findReferencesTool, findReferences, diagnosticsTool, diagnostics, } from './lsp.js';
import { updateWorkingCheckpointTool, updateWorkingCheckpoint, memoryAddTool, memoryAdd, memoryListTool, memoryList, memoryForgetTool, memoryForget, verifyProjectTool, verifyProject, } from './memory-tools.js';
export { setDangerouslySkipPermissions, setApprovalHandler, clearApprovalHandler, setApprovalMode, getApprovalMode } from '../utils/approval.js';
export { recordSubAgentStatus } from './agent-status.js';
export { DEFAULT_TEAM, TEAM_CHANNEL, postMessage, readMessages, listTeams, clearTeam, teamRoster, defineAgent, getAgent, listAgents, clearAgents, recordSpawnIntent, listSpawnIntents, clearSpawnIntents, } from '../utils/team.js';
export { isNotification } from './notify.js';
export { parseProgress } from './progress.js';
// `parallel` delegates back to this dispatcher without a circular static import.
setParallelExecutor((name, args, ctx) => handleToolCall(name, args, ctx));
export { setAskHandler, clearAskHandler, hasAskHandler } from './ask.js';
// All tool definitions — passed to the LLM
export const tools = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    searchFilesTool,
    globTool,
    bashTool,
    todoReadTool,
    todoWriteTool,
    webfetchTool,
    askQuestionTool,
    applyPatchTool,
    startProcessTool,
    pollProcessTool,
    writeProcessStdinTool,
    stopProcessTool,
    gitStatusTool,
    gitDiffTool,
    gitAddTool,
    gitCommitTool,
    gitStashTool,
    webSearchTool,
    readSubagentTool,
    // File operations
    multieditTool,
    deleteTool,
    renameTool,
    moveTool,
    copyTool,
    mkdirTool,
    statTool,
    diffTool,
    // System & process
    envTool,
    whichTool,
    commandExistsTool,
    watchTool,
    killTool,
    backgroundTool,
    // Search & discovery
    codesearchTool,
    searchDocsTool,
    findSymbolTool,
    searchHistoryTool,
    // Task coordination
    planTool,
    parallelTool,
    agentStatusTool,
    agentMessageTool,
    teamPostTool,
    teamReadTool,
    teamListTool,
    teamSpawnTool,
    agentDefineTool,
    taskResultTool,
    notifyTool,
    progressTool,
    openUrlTool,
    undoTool,
    readImageTool,
    goToDefinitionTool,
    findReferencesTool,
    diagnosticsTool,
    // Harness state: notes, memory, verification
    updateWorkingCheckpointTool,
    memoryAddTool,
    memoryListTool,
    memoryForgetTool,
    verifyProjectTool,
];
// Mutable tools list — MCP and sub-agent tools get appended at runtime
let dynamicTools = [];
export function registerDynamicTool(tool) {
    const toolName = tool.function.name;
    dynamicTools = dynamicTools.filter((existing) => existing.function.name !== toolName);
    dynamicTools.push(tool);
}
export function unregisterDynamicTool(toolName) {
    dynamicTools = dynamicTools.filter((tool) => tool.function.name !== toolName);
}
export function clearDynamicTools() {
    dynamicTools = [];
}
export function getAllTools() {
    return [...tools, ...dynamicTools];
}
// Dynamic tool handlers (for MCP tools, etc.)
const dynamicHandlers = new Map();
export function registerDynamicHandler(name, handler) {
    dynamicHandlers.set(name, handler);
}
export function isDynamicToolName(name) {
    return dynamicHandlers.has(name);
}
export function unregisterDynamicHandler(name) {
    dynamicHandlers.delete(name);
}
/**
 * Dispatch a tool call to the appropriate handler.
 * Returns the tool result as a string.
 */
const MAX_TOOL_RESULT_CHARS = 50_000;
/**
 * Keep tool output within a predictable budget so one oversized result
 * (huge file, web page, MCP response) cannot blow up the model context.
 */
export function truncateToolResult(result) {
    const sanitized = String(result).replaceAll('\0', '');
    if (sanitized.length <= MAX_TOOL_RESULT_CHARS) {
        return sanitized;
    }
    // Keep the tail too — build/test errors are usually at the end of output.
    const marker = `\n… truncated … (tool result truncated, ${sanitized.length} chars total; showing head and tail)\n`;
    const budget = MAX_TOOL_RESULT_CHARS - marker.length;
    const head = Math.ceil(budget * 0.4);
    const tail = budget - head;
    return `${sanitized.slice(0, head)}${marker}${sanitized.slice(sanitized.length - tail)}`;
}
/** First provided (non-nullish) value among `keys`, or undefined. */
function pickArg(args, ...keys) {
    for (const key of keys) {
        const value = args[key];
        if (value !== undefined && value !== null)
            return value;
    }
    return undefined;
}
// Canonical key first, then the alias keys models commonly emit for it.
const ARG_KEYS = {
    filePath: ['file_path', 'path', 'filename', 'file'],
    directory: ['directory_path', 'path', 'dir', 'directory'],
    searchTerm: ['search_term', 'query', 'pattern', 'text', 'q'],
    globPattern: ['pattern', 'query', 'name', 'glob'],
    command: ['command', 'cmd'],
    url: ['url', 'link'],
    query: ['query', 'search_term', 'q'],
    name: ['name', 'variable', 'command', 'cmd'],
};
// Reusable specs so aliases and their canonical tools share one definition.
const S = {
    filePath: { canonical: 'file_path', aliases: [...ARG_KEYS.filePath], required: true },
    directory: { canonical: 'directory_path', aliases: [...ARG_KEYS.directory] },
    searchTerm: { canonical: 'search_term', aliases: [...ARG_KEYS.searchTerm], required: true },
    globPattern: { canonical: 'pattern', aliases: [...ARG_KEYS.globPattern], required: true },
    command: { canonical: 'command', aliases: [...ARG_KEYS.command], required: true },
    url: { canonical: 'url', aliases: [...ARG_KEYS.url], required: true },
    format: { canonical: 'format', aliases: [] },
    query: { canonical: 'query', aliases: [...ARG_KEYS.query], required: true },
    name: { canonical: 'name', aliases: [...ARG_KEYS.name], required: true },
    source: { canonical: 'source', aliases: [], required: true },
    destination: { canonical: 'destination', aliases: [], required: true },
    id: { canonical: 'id', aliases: [], required: true },
};
/**
 * Per-tool argument specs. `aliases` are folded into the canonical key before
 * dispatch, and `required` keys get an actionable error when absent. Only
 * clearly-required args are marked; optional fields are left to handlers.
 */
const TOOL_ARGS = {
    read_file: [S.filePath],
    write_file: [S.filePath, { canonical: 'content', aliases: ['text'], required: true }],
    edit_file: [
        S.filePath,
        { canonical: 'old_string', aliases: ['old'], required: true },
        { canonical: 'new_string', aliases: ['new'], required: true },
    ],
    list_directory: [S.directory],
    search_files: [S.searchTerm, S.directory],
    glob: [S.globPattern, S.directory],
    bash: [S.command],
    webfetch: [S.url, S.format],
    web_search: [S.query],
    apply_patch: [{ canonical: 'patch', aliases: [], required: true }],
    multiedit: [{ canonical: 'edits', aliases: [], required: true }],
    delete: [S.filePath],
    rename: [S.source, S.destination],
    move: [S.source, S.destination],
    copy: [S.source, S.destination],
    mkdir: [{ canonical: 'directory_path', aliases: [...ARG_KEYS.directory], required: true }],
    stat: [S.filePath],
    env: [S.name],
    which: [S.name],
    command_exists: [S.name],
    watch: [{ canonical: 'path', aliases: [...ARG_KEYS.filePath], required: true }],
    start_process: [S.command, S.directory],
    write_process_stdin: [S.id, { canonical: 'data', aliases: [], required: true }],
    poll_process: [S.id],
    stop_process: [S.id],
    codesearch: [S.query],
    search_docs: [S.query],
    find_symbol: [{ canonical: 'symbol', aliases: [], required: true }, S.directory],
    search_history: [S.query],
    open_url: [S.url],
    parallel: [{ canonical: 'calls', aliases: [], required: true }],
    notify: [{ canonical: 'message', aliases: [], required: true }],
    progress: [{ canonical: 'percent', aliases: [], required: true }],
    team_post: [{ canonical: 'body', aliases: ['message', 'text'], required: true }],
    team_spawn: [
        { canonical: 'name', aliases: ['agent_name', 'agent'], required: true },
        { canonical: 'task', aliases: ['prompt', 'instructions'], required: true },
    ],
    agent_define: [
        { canonical: 'name', aliases: ['agent_name'], required: true },
        { canonical: 'description', aliases: [], required: true },
        { canonical: 'system_prompt', aliases: ['systemPrompt', 'prompt'], required: true },
    ],
    // New tools
    undo: [{ canonical: 'id', aliases: [] }],
    read_image: [S.filePath],
    go_to_definition: [{ canonical: 'symbol', aliases: [], required: true }, S.directory],
    find_references: [{ canonical: 'symbol', aliases: [], required: true }, S.directory],
    diagnostics: [S.directory],
    update_working_checkpoint: [{ canonical: 'content', aliases: [], required: true }],
    memory_add: [{ canonical: 'text', aliases: [], required: true }],
    memory_forget: [{ canonical: 'target', aliases: [], required: true }],
    // Aliases — same specs as the canonical tool they delegate to.
    grep: [S.searchTerm, S.directory],
    search_text: [S.searchTerm, S.directory],
    list: [S.directory],
    find_file: [S.globPattern, S.directory],
    shell: [S.command],
    terminal: [S.command],
    run: [S.command],
    fetch_url: [S.url, S.format],
    websearch: [S.query],
};
/** Fill canonical keys from any accepted alias, returning a copy only when needed. */
function normalizeToolArgs(toolName, args) {
    const specs = TOOL_ARGS[toolName];
    if (!specs)
        return args;
    let copy;
    for (const spec of specs) {
        if (args[spec.canonical] === undefined || args[spec.canonical] === null) {
            const value = pickArg(args, ...spec.aliases);
            if (value !== undefined) {
                copy ??= { ...args };
                copy[spec.canonical] = value;
            }
        }
    }
    return copy ?? args;
}
function missingRequiredArg(toolName, args) {
    for (const spec of TOOL_ARGS[toolName] ?? []) {
        if (spec.required && pickArg(args, spec.canonical) === undefined) {
            return `Error: ${toolName} requires ${spec.canonical}`;
        }
    }
    return undefined;
}
/** Guarantee a string payload even if a handler returns undefined or an object. */
function normalizeToolResult(toolName, value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null) {
        return `Error: tool "${toolName}" returned no output`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        }
        catch {
            // fall through to String()
        }
    }
    return String(value);
}
/** Three closest registered tool names for a helpful unknown-tool error. */
function suggestToolNames(toolName, candidates, limit = 3) {
    const needle = toolName.toLowerCase();
    return [...new Set(candidates)]
        .filter((name) => name.length > 0)
        .map((name) => ({ name, distance: leven(needle, name.toLowerCase()) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((entry) => entry.name);
}
// Plan mode is enforced here, below the approval layer, so `auto`/`yolo`
// cannot accidentally mutate files while the user is planning.
let planMode = false;
export function setPlanMode(value) { planMode = value; }
export function isPlanMode() { return planMode; }
const MUTATING_TOOLS = new Set([
    'write_file', 'edit_file', 'apply_patch', 'multiedit', 'delete', 'rename', 'move',
    'copy', 'mkdir', 'git_add', 'git_commit', 'git_stash', 'undo', 'bash', 'shell',
    'terminal', 'run', 'start_process', 'background', 'kill', 'stop_process', 'watch',
    'sub_agent', 'verify_project',
]);
/**
 * Alternative names the dispatcher accepts. Models invent these constantly, so
 * they must also appear in `getValidToolNames()` — otherwise the 400-repair path
 * deletes a call the dispatcher would have executed happily.
 */
export const TOOL_NAME_ALIASES = new Set([
    'grep',
    'search_text',
    'list',
    'find_file',
    'shell',
    'terminal',
    'run',
    'fetch_url',
    'websearch',
    'task',
    'subagent',
    'question',
    'confirm',
    'select',
    'input',
    'approval',
    'background',
    'kill',
    'plan',
    'agent_status',
    'agent_message',
    'task_result',
    'notify',
    'progress',
    'open_url',
    'codesearch',
    'search_docs',
    'find_symbol',
    'command_exists',
]);
export async function handleToolCall(toolName, args, context = {}) {
    if (planMode && MUTATING_TOOLS.has(toolName)) {
        return `Error: ${toolName} is blocked in plan mode. Press Tab to switch to build mode.`;
    }
    if (args == null) {
        args = {};
    }
    else if (typeof args !== 'object' || Array.isArray(args)) {
        return `Error: arguments for "${toolName}" must be a JSON object.`;
    }
    try {
        const result = await dispatchToolCall(toolName, args, context);
        return truncateToolResult(normalizeToolResult(toolName, result));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return truncateToolResult(`Error: ${msg}`);
    }
}
async function dispatchToolCall(toolName, rawArgs, context) {
    const args = normalizeToolArgs(toolName, rawArgs);
    const missing = missingRequiredArg(toolName, args);
    if (missing)
        return missing;
    switch (toolName) {
        case 'read_file':
            if (args.ranges != null && (args.offset != null || args.limit != null)) {
                return 'Error: use either ranges or offset/limit, not both.';
            }
            return await readFile(args.file_path, args.offset, args.limit, context.sessionId, args.ranges);
        case 'write_file':
            return await writeFile(args.file_path, args.content, context.sessionId);
        case 'edit_file':
            return await editFile(args.file_path, args.old_string, args.new_string, args.expected_replacements, context.sessionId);
        case 'list_directory':
            return await listDirectory(args.directory_path);
        case 'search_files':
            return await searchFiles(args.search_term, args.directory_path, args.case_sensitive, args.file_extensions, context.abortSignal);
        case 'glob':
            return await globFiles(args.pattern, args.directory_path);
        case 'bash':
            return await runBash(args.command, args.timeout_ms, context.sessionId, context.abortSignal, args.cwd);
        case 'todo_read':
            return readTodos(context.sessionId);
        case 'todo_write':
            return writeTodos(args.todos, context.sessionId);
        case 'webfetch': {
            const result = await webfetch(args.url, args.format, args.timeout);
            return JSON.stringify(result);
        }
        case 'ask_user': {
            const request = normalizeAskRequest(args);
            return await askUser(request, context.sessionId);
        }
        case 'sub_agent':
            return 'Error: sub_agent is executed by the agentic loop, not by handleToolCall. It is handled directly by the loop.';
        case 'apply_patch':
            return await applyPatch(args.patch, context.sessionId);
        case 'start_process':
            return await startProcess(args.command, context.sessionId, args.cwd ?? args.directory_path ?? args.directory);
        case 'poll_process':
            return pollProcess(args.id);
        case 'write_process_stdin':
            return writeProcessStdin(args.id, args.data);
        case 'stop_process':
            return stopProcess(args.id);
        case 'git_status':
            return await gitStatus(args.short);
        case 'git_diff':
            return await gitDiff(args.staged, args.stat);
        case 'git_add':
            return await gitAdd(args.paths, args.all, context.sessionId);
        case 'git_commit':
            return await gitCommit(args.message, args.amend, context.sessionId);
        case 'git_stash':
            return await gitStash(args.action, args.message, context.sessionId);
        case 'web_search':
            return await webSearch(args.query, args.timeout);
        case 'read_subagent':
            return await readSubagent(args, context);
        // ── File operations ──
        case 'multiedit':
            return await multiedit(args.edits, context.sessionId);
        case 'delete':
            return await deletePath(args.file_path, args.recursive, context.sessionId);
        case 'rename':
            return await renamePath(args.source, args.destination, args.overwrite, context.sessionId);
        case 'move':
            return await movePath(args.source, args.destination, args.overwrite, context.sessionId);
        case 'copy':
            return await copyPath(args.source, args.destination, args.recursive, args.overwrite, context.sessionId);
        case 'mkdir':
            return await makeDirectory(args.directory_path, args.recursive, context.sessionId);
        case 'stat':
            return await statPath(args.file_path, context.sessionId);
        case 'diff':
            return await diffFiles(args, context.sessionId);
        // ── System & process ──
        case 'env':
            return await readEnv(args.name, args.redact !== false);
        case 'which':
            return await which(args.name);
        case 'command_exists':
            return await commandExists(args.name);
        case 'watch':
            return await watch(args.path, args.duration_ms, args.command, context.sessionId);
        case 'kill':
            return await kill(args.pid, args.id, context.sessionId);
        case 'background':
            return await background(args.command, context.sessionId);
        // ── Search & discovery ──
        case 'codesearch':
            return await codesearch(args.query, args.language, args.limit);
        case 'search_docs':
            return await searchDocs(args.query, args.source);
        case 'find_symbol':
            return await findSymbol(args.symbol, args.directory_path, args.kind);
        case 'search_history':
            return await searchHistory(args.query);
        // ── Task coordination & control ──
        case 'plan':
            return await plan(args, context);
        case 'parallel':
            return await runParallel(args, context);
        case 'agent_status':
            return await agentStatus(args);
        case 'agent_message':
            return await agentMessage(args);
        case 'team_post':
            return await teamPost(args);
        case 'team_read':
            return await teamRead(args);
        case 'team_list':
            return await teamList(args);
        case 'team_spawn':
            return await teamSpawn(args);
        case 'agent_define':
            return await agentDefine(args);
        case 'task_result':
            return await taskResult(args, context);
        case 'notify':
            return await notify(args);
        case 'progress':
            return await progress(args);
        case 'open_url':
            return await openUrl(args);
        // ── Undo, images & LSP-ish navigation ──
        case 'undo':
            return await undo(args.id, context.sessionId);
        case 'read_image':
            return await readImage(args.file_path);
        case 'go_to_definition':
            return await goToDefinition(args.symbol, args.directory_path);
        case 'find_references':
            return await findReferences(args.symbol, args.directory_path);
        case 'diagnostics':
            return await diagnostics(args.directory_path);
        // ── Harness state: working notes, durable memory, project checks ──
        case 'update_working_checkpoint':
            return await updateWorkingCheckpoint(args, context.sessionId);
        case 'memory_add':
            return await memoryAdd(args);
        case 'memory_list':
            return await memoryList(args);
        case 'memory_forget':
            return await memoryForget(args);
        case 'verify_project':
            return await verifyProject(args);
        // ── Aliases for common tool names (same implementation, friendly names) ──
        // Args are normalized above, so alias-style keys arrive under canonical names.
        case 'grep':
        case 'search_text':
            return await searchFiles(args.search_term, args.directory_path, args.case_sensitive, args.file_extensions, context.abortSignal);
        case 'list':
            return await listDirectory(args.directory_path);
        case 'find_file':
            return await globFiles(args.pattern, args.directory_path);
        case 'shell':
        case 'terminal':
        case 'run':
            return await runBash(args.command, args.timeout_ms, context.sessionId, context.abortSignal, args.cwd);
        case 'fetch_url': {
            const result = await webfetch(args.url, args.format ?? 'text', args.timeout);
            return JSON.stringify(result);
        }
        case 'websearch':
            return await webSearch(args.query, args.timeout);
        case 'task':
        case 'subagent':
            return 'Error: sub_agent is executed by the agentic loop, not by handleToolCall. It is handled directly by the loop.';
        case 'question':
        case 'confirm':
        case 'select':
        case 'input':
        case 'approval': {
            const request = normalizeAskRequest(args);
            return await askUser(request, context.sessionId);
        }
        default: {
            // Check dynamic handlers (MCP tools, sub-agent tools)
            const handler = dynamicHandlers.get(toolName);
            if (handler) {
                return await handler(args);
            }
            const names = ['sub_agent', ...getAllTools().map((tool) => tool.function.name)];
            const suggestions = suggestToolNames(toolName, names);
            const hint = suggestions.length
                ? ` Did you mean: ${suggestions.map((name) => `"${name}"`).join(', ')}?`
                : '';
            return `Error: Unknown tool "${toolName}".${hint}`;
        }
    }
}

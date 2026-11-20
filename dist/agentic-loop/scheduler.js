/**
 * scheduler.ts — decides the execution order for a turn's tool calls.
 *
 * The rule is a write barrier: read-only and context-only calls may run
 * concurrently, but any call that can mutate the workspace runs alone, and
 * everything after it waits. Two `write_file` calls therefore apply in the order
 * the model declared them instead of racing, while a burst of `read_file`,
 * `search_files` and `glob` calls still runs in parallel.
 *
 * Pure and dependency-free so it can be unit tested without a model or a
 * filesystem.
 */
/**
 * Tools that only observe the workspace. Running them together is safe because
 * none of them changes what the others see.
 */
export const READ_ONLY_TOOLS = new Set([
    'read_file',
    'read_image',
    'list_directory',
    'search_files',
    'glob',
    'grep',
    'search_text',
    'list',
    'find_file',
    'codesearch',
    'search_docs',
    'find_symbol',
    'search_history',
    'go_to_definition',
    'find_references',
    'diagnostics',
    'stat',
    'env',
    'which',
    'command_exists',
    'webfetch',
    'fetch_url',
    'web_search',
    'websearch',
    'open_url',
    'poll_process',
]);
/**
 * Tools that touch harness state rather than the workspace. They are ordered
 * after file writes within a turn but never mutate the working tree, so they can
 * share a batch.
 */
export const META_TOOLS = new Set([
    'todo',
    'todo_write',
    'todo_read',
    'update_working_checkpoint',
    'memory_add',
    'memory_list',
    'memory_forget',
    'progress',
    'notify',
]);
/** Tools that may change the workspace, git state, or run arbitrary commands. */
export const WRITE_TOOLS = new Set([
    'write_file',
    'edit_file',
    'apply_patch',
    'multiedit',
    'delete',
    'rename',
    'move',
    'copy',
    'mkdir',
    'undo',
    'bash',
    'shell',
    'terminal',
    'run',
    'start_process',
    'background',
    'kill',
    'stop_process',
    'write_process_stdin',
    'watch',
    'sub_agent',
    'git_add',
    'git_commit',
    'git_stash',
    'parallel',
]);
function toolName(call) {
    const direct = call?.name;
    if (typeof direct === 'string' && direct.trim())
        return direct.trim();
    const nested = call?.function?.name;
    return typeof nested === 'string' ? nested.trim() : '';
}
/** Unknown tools are treated as writes: forward compatibility over throughput. */
export function isReadOnlyTool(name) {
    return READ_ONLY_TOOLS.has(name) || META_TOOLS.has(name);
}
export function isWriteTool(name) {
    return WRITE_TOOLS.has(name);
}
/**
 * Group calls into batches.
 *
 * Consecutive read-only/meta calls collapse into one parallel batch; every write
 * becomes a serial batch of its own, which is the barrier.
 */
export function planToolBatches(calls, options = {}) {
    const batches = [];
    let open = null;
    for (let index = 0; index < calls.length; index++) {
        const name = toolName(calls[index]);
        const parallelSafe = isReadOnlyTool(name)
            || (name.length > 0 && !isWriteTool(name) && options.isParallelSafe?.(name) === true);
        if (parallelSafe) {
            if (!open) {
                open = { mode: 'parallel', indexes: [] };
                batches.push(open);
            }
            open.indexes.push(index);
            continue;
        }
        open = null;
        batches.push({ mode: 'serial', indexes: [index] });
    }
    return batches;
}
/** Compact description used by logs and `--verbose` tracing. */
export function describeBatches(batches, calls) {
    return batches
        .map((batch) => {
        const names = batch.indexes.map((index) => toolName(calls[index]) || 'unknown');
        return `${batch.mode}[${names.join(',')}]`;
    })
        .join(' -> ');
}
/** True when a plan contains nothing that can modify the workspace. */
export function planIsReadOnly(batches) {
    return batches.every((batch) => batch.mode === 'parallel');
}

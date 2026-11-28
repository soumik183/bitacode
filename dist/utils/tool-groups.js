/**
 * tool-groups.ts — group the built-in tools so each request can send only the
 * schemas it actually needs instead of the full ~6.8k-token tool catalog.
 *
 * A group selection is *configuration*, not user input: it comes from an env
 * value or a settings string, so every helper here degrades safely rather than
 * throwing inside the agent loop. Unknown tool names fall into `core` (fail
 * closed — they stay visible under the default group), and a selection that
 * would hide every tool falls back to showing all of them.
 *
 * The dispatcher is unchanged: tools are only filtered out of the `tools`
 * array sent to the model, so calls for hidden tools still execute normally.
 */
import { logger } from './logger.js';
/** Concrete groups. `all` is deliberately excluded: it expands to these. */
export const ALL_TOOL_GROUPS = ['core', 'files', 'web', 'process', 'agents'];
const VALID_GROUPS = new Set([...ALL_TOOL_GROUPS, 'all']);
/** Forgiving spellings accepted by env/style settings. */
const GROUP_ALIASES = new Map([
    ['default', 'core'],
    ['basic', 'core'],
    ['file', 'files'],
    ['filesystem', 'files'],
    ['internet', 'web'],
    ['system', 'process'],
    ['agent', 'agents'],
    ['subagent', 'agents'],
    ['everything', 'all'],
    ['full', 'all'],
    ['*', 'all'],
]);
/**
 * Explicit name → group table. Covers every tool in `src/tools/index.ts`, the
 * loop-level tools (`sub_agent`, `activate_skill`) and the dispatcher aliases.
 * A `Map` is used so inherited keys such as `toString` cannot be mistaken for
 * a group.
 */
const TOOL_GROUP_BY_NAME = new Map([
    // ── core: the small everyday set ──
    ['read_file', 'core'],
    ['list_directory', 'core'],
    ['search_files', 'core'],
    ['glob', 'core'],
    ['todo_read', 'core'],
    ['todo_write', 'core'],
    ['ask_user', 'core'],
    // Harness state (notes/memory) is cheap and useful in every session.
    ['update_working_checkpoint', 'core'],
    ['memory_add', 'core'],
    ['memory_list', 'core'],
    ['memory_forget', 'core'],
    // Dispatcher aliases keep the group of the tool they delegate to.
    ['grep', 'core'],
    ['search_text', 'core'],
    ['list', 'core'],
    ['find_file', 'core'],
    ['question', 'core'],
    ['confirm', 'core'],
    ['select', 'core'],
    ['input', 'core'],
    ['approval', 'core'],
    // ── files: reading, editing, navigation and image inspection ──
    ['read_lines', 'files'],
    ['write_file', 'files'],
    ['edit_file', 'files'],
    ['multiedit', 'files'],
    ['apply_patch', 'files'],
    ['delete', 'files'],
    ['rename', 'files'],
    ['move', 'files'],
    ['copy', 'files'],
    ['mkdir', 'files'],
    ['stat', 'files'],
    ['diff', 'files'],
    ['undo', 'files'],
    ['read_image', 'files'],
    ['codesearch', 'files'],
    ['find_symbol', 'files'],
    ['go_to_definition', 'files'],
    ['find_references', 'files'],
    ['diagnostics', 'files'],
    // ── web: anything that reaches the network ──
    ['webfetch', 'web'],
    ['web_search', 'web'],
    ['open_url', 'web'],
    ['search_docs', 'web'],
    ['search_history', 'web'],
    ['fetch_url', 'web'],
    ['websearch', 'web'],
    // ── process: shell, git and long-running processes ──
    ['bash', 'process'],
    ['start_process', 'process'],
    ['poll_process', 'process'],
    ['write_process_stdin', 'process'],
    ['stop_process', 'process'],
    ['git_status', 'process'],
    ['git_diff', 'process'],
    ['git_add', 'process'],
    ['git_commit', 'process'],
    ['git_stash', 'process'],
    ['env', 'process'],
    ['which', 'process'],
    ['command_exists', 'process'],
    ['watch', 'process'],
    ['kill', 'process'],
    ['background', 'process'],
    ['verify_project', 'process'],
    ['shell', 'process'],
    ['terminal', 'process'],
    ['run', 'process'],
    // ── agents: delegation, coordination and planning ──
    ['sub_agent', 'agents'],
    ['read_subagent', 'agents'],
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
    ['activate_skill', 'agents'],
    ['task', 'agents'],
    ['subagent', 'agents'],
]);
function debugUnexpected(where, err) {
    try {
        logger.debug(`tool-groups: ${where}; falling back to a safe default`, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    catch {
        // Logging itself must never break tool filtering.
    }
}
/** Normalize one comma/space separated token into a group, or undefined. */
function groupToken(token) {
    const cleaned = token.toLowerCase().trim().replace(/^["']|["']$/g, '');
    if (VALID_GROUPS.has(cleaned))
        return cleaned;
    return GROUP_ALIASES.get(cleaned);
}
/** Add a group (expanding `all`) to an ordered, deduplicated result. */
function pushGroup(group, out, seen) {
    if (group === 'all') {
        for (const expanded of ALL_TOOL_GROUPS)
            pushGroup(expanded, out, seen);
        return;
    }
    if (seen.has(group))
        return;
    seen.add(group);
    out.push(group);
}
/**
 * Group a tool by name. Unknown/MCP/dynamic tools return `core`, which keeps
 * them visible with the default selection rather than silently dropping them.
 */
export function groupForTool(name) {
    try {
        if (typeof name !== 'string')
            return 'core';
        return TOOL_GROUP_BY_NAME.get(name) ?? 'core';
    }
    catch (err) {
        debugUnexpected('groupForTool failed', err);
        return 'core';
    }
}
/**
 * Parse an env-style `core,files web` setting. Unknown tokens are ignored,
 * duplicates removed (first occurrence wins), `all` expands to every concrete
 * group, and empty/malformed input yields the safe default `['core']`.
 * Never throws.
 */
export function parseToolGroups(value) {
    try {
        if (typeof value !== 'string' || value.trim() === '')
            return ['core'];
        const out = [];
        const seen = new Set();
        for (const raw of value.split(/[\s,]+/)) {
            const group = groupToken(raw);
            if (group)
                pushGroup(group, out, seen);
        }
        return out.length > 0 ? out : ['core'];
    }
    catch (err) {
        debugUnexpected('parseToolGroups failed', err);
        return ['core'];
    }
}
/** Resolve a groups option into a set, or `all` when nothing usable was given. */
function selectedGroups(groups) {
    if (!groups || groups.length === 0)
        return 'all';
    const out = new Set();
    try {
        for (const raw of groups) {
            const group = groupToken(typeof raw === 'string' ? raw : '');
            if (!group)
                continue;
            if (group === 'all')
                return 'all';
            out.add(group);
        }
    }
    catch (err) {
        debugUnexpected('selectedGroups failed', err);
        return 'all';
    }
    return out.size > 0 ? out : 'all';
}
/**
 * Filter tool definitions to the selected groups, keeping the tools named in
 * `alwaysVisible` regardless of group. Original order and object identity are
 * preserved. With no groups configured (or a useless selection) all tools stay
 * visible; a selection that matches nothing also falls back to all tools.
 * Never throws.
 */
export function resolveVisibleTools(allTools, options = {}) {
    try {
        if (!Array.isArray(allTools) || allTools.length === 0)
            return [];
        const groups = selectedGroups(options?.groups);
        if (groups === 'all')
            return [...allTools];
        const always = new Set();
        if (Array.isArray(options?.alwaysVisible)) {
            for (const name of options.alwaysVisible) {
                if (typeof name === 'string' && name.length > 0)
                    always.add(name);
            }
        }
        const visible = [];
        for (const tool of allTools) {
            const name = tool?.function?.name;
            // Malformed definitions are kept rather than disappearing silently.
            if (typeof name !== 'string' || name.length === 0) {
                visible.push(tool);
                continue;
            }
            if (always.has(name) || groups.has(groupForTool(name))) {
                visible.push(tool);
            }
        }
        // A filter must never leave the model with no tools at all.
        if (visible.length === 0) {
            logger.debug('tool-groups: selection hid every tool; showing all tools');
            return [...allTools];
        }
        return visible;
    }
    catch (err) {
        debugUnexpected('resolveVisibleTools failed', err);
        return Array.isArray(allTools) ? [...allTools] : [];
    }
}
/**
 * Short, stable one-line description of a selection for `/settings`.
 * Empty or invalid input describes the default group.
 */
export function describeGroups(groups) {
    try {
        if (!Array.isArray(groups))
            return 'core';
        const tokens = [];
        for (const group of groups) {
            if (typeof group === 'string')
                tokens.push(group);
        }
        const list = parseToolGroups(tokens.join(','));
        if (ALL_TOOL_GROUPS.every((group) => list.includes(group)))
            return 'all tools';
        return list.join(', ');
    }
    catch (err) {
        debugUnexpected('describeGroups failed', err);
        return 'core';
    }
}

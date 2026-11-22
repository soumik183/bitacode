/**
 * Tool execution module for the agentic loop.
 *
 * Responsibilities, in the order a call goes through them:
 *
 *  1. scheduling    — `scheduler.ts` groups read-only calls in parallel and puts
 *                     a barrier around every call that can write;
 *  2. permission    — `permission-rules.ts` decides allow / ask / deny;
 *  3. hooks         — PreToolUse may block, PostToolUse may add context;
 *  4. read guard    — mutating a file the model has not read is refused, and a
 *                     re-read of unchanged bytes returns a stub;
 *  5. execution     — sub-agents get their own path, everything else dispatches;
 *  6. result budget — large output spills to disk with a preview + path;
 *  7. postcondition — a cheap verify step appends ok/warn/fail to the result.
 *
 * Results are always appended in the model's own tool_call order, so provider
 * history stays valid even when calls finish out of order.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleToolCall, truncateToolResult, isPlanMode, isDynamicToolName } from '../tools/index.js';
import { runSubAgent, runSubAgentFollowUp, abortSubAgentRun, isSubAgentRunning, listRunningSubAgentIds, } from '../sub-agent.js';
import { listSubAgentRuns, loadSubAgentRun, releaseSubAgentRun, } from '../utils/subagent-store.js';
import { logger } from '../utils/logger.js';
import { createCheckpoint } from '../utils/checkpoint.js';
import { getWorkingDirectory } from '../utils/path-validation.js';
import { planToolBatches, describeBatches } from './scheduler.js';
import { isFileUnchangedSinceRead, recordFileRead, recordFileWrite, readRecordFor, unchangedReadStub, wasFileRead, } from '../utils/read-state.js';
import { applyToolResultBudget, DEFAULT_MAX_INLINE } from '../utils/tool-result-budget.js';
import { verifyToolPostcondition, renderVerifyNote } from '../utils/tool-verify.js';
import { runHooks } from '../utils/hooks.js';
import { evaluatePermission } from '../utils/permission-rules.js';
import { runWithApprovalOverride } from '../utils/approval.js';
import { appendJournal } from '../utils/session-journal.js';
import { recordTurnCheckpoint } from '../utils/turn-snapshots.js';
/** Max independent tool calls launched at once within a parallel batch. */
const CONCURRENCY = 4;
/** Tools whose effects should be snapshotted before they run. */
const CHECKPOINT_TOOLS = new Set([
    'write_file', 'edit_file', 'apply_patch', 'multiedit',
    'delete', 'rename', 'move', 'copy',
    'git_add', 'git_commit', 'git_stash',
]);
/** Tools that are checked against read-state before running. */
const READ_GUARDED_TOOLS = new Set(['edit_file', 'apply_patch', 'multiedit']);
/** Tools that produce file bytes worth remembering for read dedupe. */
const READ_TOOLS = new Set(['read_file']);
/** Tools that create or rewrite a file, so the bytes are known without a read. */
const WRITE_TOOLS = new Set(['write_file']);
/** Best-effort extraction of the file paths a mutating tool is about to touch. */
function checkpointPaths(name, args) {
    const paths = [];
    const add = (value) => {
        if (typeof value === 'string' && value.trim())
            paths.push(value);
    };
    switch (name) {
        case 'write_file':
        case 'edit_file':
        case 'delete':
            add(args.file_path ?? args.path);
            break;
        case 'apply_patch':
            if (typeof args.patch === 'string') {
                for (const match of args.patch.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)) {
                    add(match[1].trim().split('\t')[0]);
                }
            }
            break;
        case 'multiedit':
            if (Array.isArray(args.edits)) {
                for (const edit of args.edits) {
                    if (edit && typeof edit === 'object')
                        add(edit.file_path ?? edit.path);
                }
            }
            break;
        case 'rename':
        case 'move':
        case 'copy':
            add(args.source);
            add(args.destination);
            break;
        case 'git_add':
            if (Array.isArray(args.paths))
                args.paths.forEach(add);
            break;
        default:
            // git_commit and git_stash have no file arguments to snapshot.
            break;
    }
    return [...new Set(paths)];
}
/** Safe name/args strings for events, even for a malformed model-provided call. */
function describeCall(toolCall) {
    const fn = toolCall?.function;
    const rawName = fn?.name;
    const rawArgs = fn?.arguments;
    return {
        id: toolCall?.id,
        name: typeof rawName === 'string' ? rawName : '',
        args: typeof rawArgs === 'string' ? rawArgs : '',
    };
}
/** Primary path a call is about, for read-state bookkeeping. */
function primaryPath(name, args, cwd) {
    const raw = name === 'read_file' || name === 'write_file' || name === 'edit_file'
        ? (args?.file_path ?? args?.path)
        : Array.isArray(args?.edits) ? (args.edits[0]?.file_path ?? args.edits[0]?.path) : undefined;
    if (typeof raw !== 'string' || !raw.trim())
        return null;
    return path.resolve(cwd, raw.trim());
}
async function statOrNull(target) {
    try {
        const info = await fs.stat(target);
        if (!info.isFile())
            return null;
        return { mtimeMs: info.mtimeMs, size: info.size };
    }
    catch {
        return null;
    }
}
/**
 * Execute all tool calls from an assistant message.
 *
 * Returns true if execution completed normally, false if aborted.
 */
export async function executeToolCalls(toolCalls, messages, onEvent, context) {
    const { sessionId, abortSignal, requestDefaults, client, model, pricing, policy } = context;
    const cwd = policy?.cwd ?? getWorkingDirectory();
    const hooks = policy?.hooks ?? [];
    const guardUnreadEdits = policy?.guardUnreadEdits === true;
    const spillToolResults = policy?.spillToolResults !== false;
    const verifyPostconditions = policy?.verifyPostconditions === true;
    const journalEnabled = policy?.journal === true;
    // Track which tool_call_ids still need a tool result message.
    // This set is used to inject stub responses on abort, preventing
    // orphaned tool_call_ids from permanently bricking the session.
    const pendingToolCallIds = new Set(toolCalls.map((tc) => tc.id));
    const injectStubsForPendingToolCalls = () => {
        for (const id of pendingToolCallIds) {
            messages.push({
                role: 'tool',
                tool_call_id: id,
                content: 'Aborted by user.',
            });
        }
    };
    /** Execute one call; never throws — reports an outcome for the coordinator to apply in order. */
    const runOne = async (toolCall) => {
        const { id, name, args: argsStr } = describeCall(toolCall);
        const fn = toolCall?.function;
        const rawName = fn?.name;
        try {
            if (typeof rawName !== 'string' || rawName.trim().length === 0 || typeof fn?.arguments !== 'string') {
                throw new Error('malformed tool call');
            }
            const args = JSON.parse(argsStr);
            const target = primaryPath(name, args, cwd);
            if (journalEnabled) {
                appendJournal(sessionId ?? 'default', {
                    type: 'tool_call',
                    data: { name, args: argsStr.slice(0, 500) },
                });
            }
            // 1. Permission rules: deny wins, ask forces the approval path.
            const permission = evaluatePermission(policy?.permissionRules, { tool: name, args, cwd });
            if (permission.decision === 'deny') {
                const reason = permission.rule ? `permission rule "${permission.rule}"` : 'permission policy';
                return {
                    id,
                    name,
                    args: argsStr,
                    status: 'error',
                    content: truncateToolResult(`Error: blocked by ${reason}`),
                    result: `blocked by ${reason}`,
                };
            }
            // 2. PreToolUse hooks: a blocking hook stops the call before any effect.
            if (hooks.length > 0) {
                const hookResult = await runHooks({
                    event: 'PreToolUse',
                    hooks,
                    cwd,
                    payload: {
                        event: 'PreToolUse',
                        sessionId,
                        cwd,
                        toolName: name,
                        toolArgs: args,
                    },
                });
                if (hookResult.blocked) {
                    return {
                        id,
                        name,
                        args: argsStr,
                        status: 'error',
                        content: `Error: blocked by a PreToolUse hook${hookResult.reason ? `: ${hookResult.reason}` : ''}`,
                        result: hookResult.reason ?? 'blocked by hook',
                    };
                }
            }
            // 3. Read guard: never rewrite a file that was not read this session.
            if (guardUnreadEdits && (READ_GUARDED_TOOLS.has(name) || WRITE_TOOLS.has(name)) && target) {
                const existing = await statOrNull(target);
                const record = readRecordFor(sessionId, target);
                if (existing && !wasFileRead(sessionId, target)) {
                    return {
                        id,
                        name,
                        args: argsStr,
                        status: 'error',
                        content: truncateToolResult(`Error: refusing to modify ${path.relative(cwd, target) || target} because it has not been read in this session.`
                            + (record?.source === 'write'
                                ? ' It was written earlier, so re-read it before editing.'
                                : ' Call read_file first, then retry the edit.')),
                        result: 'unread file',
                    };
                }
            }
            // 4. Read dedupe: unchanged bytes come back as a stub, not a second copy.
            if (READ_TOOLS.has(name) && target && args.full !== true) {
                const existing = await statOrNull(target);
                const record = readRecordFor(sessionId, target);
                if (existing && record && isFileUnchangedSinceRead(sessionId, target, existing)) {
                    const stub = unchangedReadStub(target, record);
                    return { id, name, args: argsStr, status: 'done', content: stub, result: stub };
                }
            }
            // Snapshot before mutating tools run; failure here must never block them.
            if (CHECKPOINT_TOOLS.has(name)) {
                try {
                    const ids = await createCheckpoint(checkpointPaths(name, args), sessionId, name);
                    if (ids.length > 0 && sessionId) {
                        recordTurnCheckpoint(sessionId, {
                            tool: name,
                            ids,
                            paths: checkpointPaths(name, args),
                        });
                    }
                }
                catch {
                    // Best-effort: checkpointing is not allowed to fail the tool call.
                }
            }
            const execute = async () => {
                // Handle sub-agent tool specially
                if (isPlanMode() && name === 'sub_agent') {
                    throw new Error('sub_agent is blocked in plan mode. Press Tab to switch to build mode.');
                }
                if (name === 'sub_agent') {
                    // Single `task` or parallel `tasks` (both are validated by runSubAgent).
                    const taskArg = Array.isArray(args.tasks)
                        ? args.tasks
                        : args.task;
                    if ((typeof taskArg === 'string' && taskArg.trim().length === 0) ||
                        (Array.isArray(taskArg) && (taskArg.length === 0 || taskArg.some((t) => typeof t !== 'string' || !t.trim())))) {
                        throw new Error('sub_agent requires a non-empty "task" or "tasks" string array.');
                    }
                    const subProgress = (evt) => {
                        onEvent({
                            type: 'sub_agent_iteration',
                            subAgentTool: { tool: evt.tool, status: evt.status, iteration: evt.iteration, args: evt.args },
                            ...(evt.subAgentTranscriptId ? { subAgentTranscriptId: evt.subAgentTranscriptId } : {}),
                            ...(evt.subAgentId ? { subAgentId: evt.subAgentId } : {}),
                            ...(evt.subAgentLabel ? { subAgentLabel: evt.subAgentLabel } : {}),
                            ...(evt.subAgentStatus ? { subAgentStatus: evt.subAgentStatus } : {}),
                            ...(evt.subAgentTask ? { subAgentTask: evt.subAgentTask } : {}),
                            ...(evt.subAgentType ? { subAgentType: evt.subAgentType } : {}),
                        });
                    };
                    const subResult = await runSubAgent(client, model, taskArg, args.max_iterations, requestDefaults, subProgress, abortSignal, pricing, args.agent_type, args.thoroughness, sessionId);
                    // Emit sub-agent usage for the UI to add to total cost
                    if (subResult.usage.inputTokens > 0 || subResult.usage.outputTokens > 0) {
                        onEvent({
                            type: 'sub_agent_iteration',
                            subAgentUsage: subResult.usage,
                        });
                    }
                    return subResult.response;
                }
                if (name === 'subagent_control') {
                    if (isPlanMode() && (args.action === 'prompt' || args.action === 'abort' || args.action === 'release')) {
                        throw new Error('subagent_control mutations are blocked in plan mode. Press Tab to switch to build mode.');
                    }
                    const action = String(args.action ?? '');
                    const id = typeof args.id === 'string' ? args.id.trim() : '';
                    if (action === 'list' || action === 'status') {
                        const runs = await listSubAgentRuns(sessionId ?? '');
                        if (action === 'list') {
                            const running = new Set(listRunningSubAgentIds());
                            const lines = runs.map((run) => `- ${run.id} · ${run.status}${running.has(run.id) ? ' · running' : ''}${run.released ? ' · released' : ''}` +
                                ` · ${run.agentType ?? 'general-purpose'} · ${run.task.slice(0, 80)}`);
                            const liveOnly = [...running].filter((runId) => !runs.some((run) => run.id === runId));
                            return [
                                `Sub-agent sessions (${runs.length} saved, ${running.size} running):`,
                                ...lines,
                                ...liveOnly.map((runId) => `- ${runId} · running (not yet saved)`),
                            ].join('\n') || 'No sub-agent sessions.';
                        }
                        if (!id)
                            return 'subagent_control status requires an id.';
                        const record = await loadSubAgentRun(sessionId ?? '', id);
                        if (!record)
                            return `No sub-agent session found with id ${id}.`;
                        return [
                            `${record.id} · ${record.status}${isSubAgentRunning(id) ? ' · running' : ''}${record.released ? ' · released' : ''}`,
                            `task: ${record.task}`,
                            `type: ${record.agentType ?? 'general-purpose'}${record.parentId ? ` · parent: ${record.parentId}` : ''}`,
                            `messages: ${record.messageCount} · tokens: ${record.usage?.totalTokens ?? 0} · cost: $${(record.usage?.estimatedCost ?? 0).toFixed(4)}`,
                            record.error ? `error: ${record.error}` : '',
                        ].filter(Boolean).join('\n');
                    }
                    if (action === 'abort') {
                        if (!id)
                            return 'subagent_control abort requires an id.';
                        return abortSubAgentRun(id)
                            ? `Aborted sub-agent ${id}.`
                            : `Sub-agent ${id} is not running (start/prompt a session to control it).`;
                    }
                    if (action === 'release') {
                        if (!id)
                            return 'subagent_control release requires an id.';
                        abortSubAgentRun(id);
                        const ok = await releaseSubAgentRun(sessionId ?? '', id);
                        return ok ? `Released sub-agent ${id}.` : `Could not release sub-agent ${id} (not found).`;
                    }
                    if (action === 'prompt') {
                        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
                        if (!id || !prompt)
                            return 'subagent_control prompt requires both id and prompt.';
                        const record = await loadSubAgentRun(sessionId ?? '', id);
                        if (!record)
                            return `No sub-agent session found with id ${id}.`;
                        if (record.released)
                            return `Sub-agent ${id} was released and cannot be prompted.`;
                        const controlProgress = (evt) => {
                            onEvent({
                                type: 'sub_agent_iteration',
                                subAgentTool: { tool: evt.tool, status: evt.status, iteration: evt.iteration, args: evt.args },
                                ...(evt.subAgentTranscriptId ? { subAgentTranscriptId: evt.subAgentTranscriptId } : {}),
                                ...(evt.subAgentId ? { subAgentId: evt.subAgentId } : {}),
                                ...(evt.subAgentLabel ? { subAgentLabel: evt.subAgentLabel } : {}),
                                ...(evt.subAgentStatus ? { subAgentStatus: evt.subAgentStatus } : {}),
                                ...(evt.subAgentTask ? { subAgentTask: evt.subAgentTask } : {}),
                                ...(evt.subAgentType ? { subAgentType: evt.subAgentType } : {}),
                            });
                        };
                        const result = await runSubAgentFollowUp(client, model, sessionId ?? '', id, prompt, {
                            requestDefaults,
                            onProgress: controlProgress,
                            abortSignal,
                            pricing,
                            maxIterations: args.max_iterations,
                        });
                        if (!result)
                            return `Could not continue sub-agent ${id}.`;
                        return result.response;
                    }
                    return `Unknown subagent_control action: ${action || '(none)'}. Use list/status/prompt/release/abort.`;
                }
                return handleToolCall(name, args, { sessionId, abortSignal });
            };
            // Rules can grant approval (skip the prompt) or force it (ignore yolo).
            let result;
            if (permission.decision === 'allow' && permission.source === 'allow') {
                result = await runWithApprovalOverride('granted', execute);
            }
            else if (permission.decision === 'ask' && permission.source === 'ask') {
                result = await runWithApprovalOverride('required', execute);
            }
            else {
                result = await execute();
            }
            // 5. Result budget: spill oversized output to disk with a preview.
            if (typeof result === 'string' && result.length > 0 && spillToolResults) {
                const budgeted = await applyToolResultBudget(result, { runId: sessionId });
                result = budgeted.content;
            }
            // 6. Read/write bookkeeping for the next call in this session.
            if (target) {
                const after = await statOrNull(target);
                if (after) {
                    if (READ_TOOLS.has(name))
                        recordFileRead(sessionId, target, after, result);
                    else if (WRITE_TOOLS.has(name) || READ_GUARDED_TOOLS.has(name)) {
                        if (WRITE_TOOLS.has(name))
                            recordFileWrite(sessionId, target, after, typeof args.content === 'string' ? args.content : undefined);
                        else
                            recordFileRead(sessionId, target, after);
                    }
                }
            }
            // 7. PostToolUse hooks: output becomes extra context on the result.
            if (hooks.length > 0) {
                const hookResult = await runHooks({
                    event: 'PostToolUse',
                    hooks,
                    cwd,
                    payload: {
                        event: 'PostToolUse',
                        sessionId,
                        cwd,
                        toolName: name,
                        toolArgs: args,
                        toolResult: result.slice(0, 4_000),
                    },
                });
                if (hookResult.context)
                    result = `${result}\n\n[hook] ${hookResult.context}`;
            }
            // 8. Postcondition verification for mutating tools.
            if (verifyPostconditions) {
                try {
                    const note = await verifyToolPostcondition({ tool: name, args, result, cwd });
                    result += renderVerifyNote(note);
                }
                catch {
                    // Verification is advisory only.
                }
            }
            // Guarantee a bounded string payload whatever the tool returned.
            result = truncateToolResult(result);
            if (journalEnabled) {
                appendJournal(sessionId ?? 'default', {
                    type: 'tool_result',
                    data: { name, status: 'done' },
                });
            }
            logger.info('Tool completed', {
                tool: name,
                resultLength: result.length,
            });
            return { id, name, args: argsStr, status: 'done', content: result, result };
        }
        catch (err) {
            const errMsg = String(err instanceof Error ? err.message : err);
            const aborted = Boolean(abortSignal?.aborted)
                || (err instanceof Error && (err.name === 'AbortError' || err.message === 'Operation aborted'));
            if (journalEnabled) {
                appendJournal(sessionId ?? 'default', {
                    type: 'tool_result',
                    data: { name, status: 'error', error: errMsg.slice(0, 300) },
                });
            }
            return {
                id,
                name,
                args: argsStr,
                status: 'error',
                content: truncateToolResult(`Error: ${errMsg}`),
                result: errMsg,
                aborted,
            };
        }
    };
    const batches = planToolBatches(toolCalls, { isParallelSafe: isDynamicToolName });
    logger.debug('Tool plan', { plan: describeBatches(batches, toolCalls) });
    /** Run a batch, returning outcomes in batch order. */
    const runBatch = async (batch) => {
        if (batch.mode === 'serial' || batch.indexes.length === 1) {
            const call = toolCalls[batch.indexes[0]];
            const { id, name, args } = describeCall(call);
            onEvent({
                type: 'tool_call',
                toolCall: { id, name, args, status: 'running' },
            });
            if (abortSignal?.aborted)
                return [{ id, name, args, status: 'skipped' }];
            const settled = await Promise.allSettled([runOne(call)]);
            return [settleToOutcome(settled[0], describeCall(call))];
        }
        const outcomes = [];
        for (let start = 0; start < batch.indexes.length; start += CONCURRENCY) {
            const chunk = batch.indexes.slice(start, start + CONCURRENCY);
            if (abortSignal?.aborted) {
                for (const index of chunk) {
                    const { id, name, args } = describeCall(toolCalls[index]);
                    outcomes.push({ id, name, args, status: 'skipped' });
                }
                continue;
            }
            for (const index of chunk) {
                const { id, name, args } = describeCall(toolCalls[index]);
                onEvent({
                    type: 'tool_call',
                    toolCall: { id, name, args, status: 'running' },
                });
            }
            const settled = await Promise.allSettled(chunk.map((index) => {
                if (abortSignal?.aborted) {
                    const { id, name, args } = describeCall(toolCalls[index]);
                    return Promise.resolve({ id, name, args, status: 'skipped' });
                }
                return runOne(toolCalls[index]);
            }));
            for (let offset = 0; offset < chunk.length; offset++) {
                outcomes.push(settleToOutcome(settled[offset], describeCall(toolCalls[chunk[offset]])));
            }
        }
        return outcomes;
    };
    for (const batch of batches) {
        if (abortSignal?.aborted) {
            logger.debug('Agentic loop aborted between tool batches');
            injectStubsForPendingToolCalls();
            return { completed: false, shouldAbort: true };
        }
        const outcomes = await runBatch(batch);
        let aborted = false;
        for (const outcome of outcomes) {
            if (outcome.status === 'skipped') {
                // Abort was signaled before this call launched; leave it pending for a stub.
                aborted = true;
                continue;
            }
            messages.push({
                role: 'tool',
                tool_call_id: outcome.id,
                content: outcome.content,
            });
            pendingToolCallIds.delete(outcome.id);
            // An aborted call keeps its error message but, as before, gets no event.
            if (outcome.status === 'error' && outcome.aborted) {
                aborted = true;
                continue;
            }
            onEvent({
                type: 'tool_result',
                toolCall: {
                    id: outcome.id,
                    name: outcome.name,
                    args: outcome.args,
                    status: outcome.status,
                    result: outcome.result,
                },
            });
        }
        if (aborted || abortSignal?.aborted) {
            logger.debug('Agentic loop aborted during tool execution');
            injectStubsForPendingToolCalls();
            return { completed: false, shouldAbort: true };
        }
    }
    return { completed: true, shouldAbort: false };
}
/** Turn a settled promise into an outcome, never throwing. */
function settleToOutcome(settled, fallback) {
    if (settled.status === 'fulfilled')
        return settled.value;
    const message = String(settled.reason);
    return {
        id: fallback.id,
        name: fallback.name,
        args: fallback.args,
        status: 'error',
        content: truncateToolResult(`Error: ${message}`),
        result: message,
    };
}
/** Re-export so callers only need this module for the default budget. */
export { DEFAULT_MAX_INLINE };

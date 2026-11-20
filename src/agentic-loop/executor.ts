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
import type { AgentEventHandler, ToolCallEvent } from '../agentic-loop.js';
import { handleToolCall, truncateToolResult, isPlanMode, isDynamicToolName } from '../tools/index.js';
import { runSubAgent, type SubAgentProgressHandler } from '../sub-agent.js';
import { logger } from '../utils/logger.js';
import { createCheckpoint } from '../utils/checkpoint.js';
import { getWorkingDirectory } from '../utils/path-validation.js';
import { planToolBatches, describeBatches, type ToolBatch } from './scheduler.js';
import {
  isFileUnchangedSinceRead,
  recordFileRead,
  recordFileWrite,
  readRecordFor,
  unchangedReadStub,
  wasFileRead,
} from '../utils/read-state.js';
import { applyToolResultBudget, DEFAULT_MAX_INLINE } from '../utils/tool-result-budget.js';
import { verifyToolPostcondition, renderVerifyNote } from '../utils/tool-verify.js';
import { runHooks, type HookCommand } from '../utils/hooks.js';
import { evaluatePermission, type PermissionRuleSet } from '../utils/permission-rules.js';
import { runWithApprovalOverride } from '../utils/approval.js';
import { appendJournal } from '../utils/session-journal.js';
import { recordTurnCheckpoint } from '../utils/turn-snapshots.js';

/** Policy knobs the loop hands down; all optional so tests can omit them. */
export interface ToolPolicy {
  permissionRules?: PermissionRuleSet;
  hooks?: readonly HookCommand[];
  /** Refuse to edit files the model has not read this session. */
  guardUnreadEdits?: boolean;
  /** Spill large results to disk instead of truncating them. */
  spillToolResults?: boolean;
  /** Append an ok/warn/fail postcondition to mutating results. */
  verifyPostconditions?: boolean;
  /** Append tool activity to the session journal. */
  journal?: boolean;
  /** Working directory used for relative path resolution. */
  cwd?: string;
}

/**
 * Context for tool execution, passed through from the main loop.
 */
export interface ToolExecutionContext {
  sessionId?: string;
  abortSignal?: AbortSignal;
  requestDefaults: Record<string, unknown>;
  client: any;  // OpenAI client
  model: string;
  pricing?: any;  // ModelPricing
  policy?: ToolPolicy;
}

/** Max independent tool calls launched at once within a parallel batch. */
const CONCURRENCY = 4;

interface CallOutcome {
  id: string;
  name: string;
  args: string;
  status: 'done' | 'error' | 'skipped';
  content?: string;
  result?: string;
  aborted?: boolean;
}

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
function checkpointPaths(name: string, args: any): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) paths.push(value);
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
          if (edit && typeof edit === 'object') add(edit.file_path ?? edit.path);
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
      if (Array.isArray(args.paths)) args.paths.forEach(add);
      break;
    default:
      // git_commit and git_stash have no file arguments to snapshot.
      break;
  }
  return [...new Set(paths)];
}

/** Safe name/args strings for events, even for a malformed model-provided call. */
function describeCall(toolCall: any): { id: string; name: string; args: string } {
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
function primaryPath(name: string, args: any, cwd: string): string | null {
  const raw = name === 'read_file' || name === 'write_file' || name === 'edit_file'
    ? (args?.file_path ?? args?.path)
    : Array.isArray(args?.edits) ? (args.edits[0]?.file_path ?? args.edits[0]?.path) : undefined;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return path.resolve(cwd, raw.trim());
}

async function statOrNull(target: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) return null;
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

/**
 * Execute all tool calls from an assistant message.
 *
 * Returns true if execution completed normally, false if aborted.
 */
export async function executeToolCalls(
  toolCalls: any[],
  messages: any[],
  onEvent: AgentEventHandler,
  context: ToolExecutionContext
): Promise<{ completed: boolean; shouldAbort: boolean }> {
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
  const pendingToolCallIds = new Set<string>(
    toolCalls.map((tc: any) => tc.id as string)
  );

  const injectStubsForPendingToolCalls = () => {
    for (const id of pendingToolCallIds) {
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: 'Aborted by user.',
      } as any);
    }
  };

  /** Execute one call; never throws — reports an outcome for the coordinator to apply in order. */
  const runOne = async (toolCall: any): Promise<CallOutcome> => {
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
            content: truncateToolResult(
              `Error: refusing to modify ${path.relative(cwd, target) || target} because it has not been read in this session.`
              + (record?.source === 'write'
                ? ' It was written earlier, so re-read it before editing.'
                : ' Call read_file first, then retry the edit.'),
            ),
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
        } catch {
          // Best-effort: checkpointing is not allowed to fail the tool call.
        }
      }

      const execute = async (): Promise<string> => {
        // Handle sub-agent tool specially
        if (isPlanMode() && name === 'sub_agent') {
          throw new Error('sub_agent is blocked in plan mode. Press Tab to switch to build mode.');
        }
        if (name === 'sub_agent') {
          // Single `task` or parallel `tasks` (both are validated by runSubAgent).
          const taskArg: string | string[] = Array.isArray(args.tasks)
            ? args.tasks
            : args.task;
          if (
            (typeof taskArg === 'string' && taskArg.trim().length === 0) ||
            (Array.isArray(taskArg) && (taskArg.length === 0 || taskArg.some((t) => typeof t !== 'string' || !t.trim())))
          ) {
            throw new Error('sub_agent requires a non-empty "task" or "tasks" string array.');
          }
          const subProgress: SubAgentProgressHandler = (evt) => {
            onEvent({
              type: 'sub_agent_iteration',
              subAgentTool: { tool: evt.tool, status: evt.status, iteration: evt.iteration, args: evt.args },
              ...(evt.subAgentId ? { subAgentId: evt.subAgentId } : {}),
              ...(evt.subAgentLabel ? { subAgentLabel: evt.subAgentLabel } : {}),
              ...(evt.subAgentStatus ? { subAgentStatus: evt.subAgentStatus } : {}),
              ...(evt.subAgentTask ? { subAgentTask: evt.subAgentTask } : {}),
            });
          };
          const subResult = await runSubAgent(
            client,
            model,
            taskArg,
            args.max_iterations,
            requestDefaults,
            subProgress,
            abortSignal,
            pricing,
            args.agent_type,
            args.thoroughness,
            sessionId,
          );
          // Emit sub-agent usage for the UI to add to total cost
          if (subResult.usage.inputTokens > 0 || subResult.usage.outputTokens > 0) {
            onEvent({
              type: 'sub_agent_iteration',
              subAgentUsage: subResult.usage as any,
            });
          }
          return subResult.response;
        }
        return handleToolCall(name, args, { sessionId, abortSignal });
      };

      // Rules can grant approval (skip the prompt) or force it (ignore yolo).
      let result: string;
      if (permission.decision === 'allow' && permission.source === 'allow') {
        result = await runWithApprovalOverride('granted', execute);
      } else if (permission.decision === 'ask' && permission.source === 'ask') {
        result = await runWithApprovalOverride('required', execute);
      } else {
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
          if (READ_TOOLS.has(name)) recordFileRead(sessionId, target, after, result);
          else if (WRITE_TOOLS.has(name) || READ_GUARDED_TOOLS.has(name)) {
            if (WRITE_TOOLS.has(name)) recordFileWrite(sessionId, target, after, typeof args.content === 'string' ? args.content : undefined);
            else recordFileRead(sessionId, target, after);
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
        if (hookResult.context) result = `${result}\n\n[hook] ${hookResult.context}`;
      }

      // 8. Postcondition verification for mutating tools.
      if (verifyPostconditions) {
        try {
          const note = await verifyToolPostcondition({ tool: name, args, result, cwd });
          result += renderVerifyNote(note);
        } catch {
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
    } catch (err) {
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

  const batches = planToolBatches(toolCalls as any, { isParallelSafe: isDynamicToolName });
  logger.debug('Tool plan', { plan: describeBatches(batches, toolCalls as any) });

  /** Run a batch, returning outcomes in batch order. */
  const runBatch = async (batch: ToolBatch): Promise<CallOutcome[]> => {
    if (batch.mode === 'serial' || batch.indexes.length === 1) {
      const call = toolCalls[batch.indexes[0]];
      const { id, name, args } = describeCall(call);
      onEvent({
        type: 'tool_call',
        toolCall: { id, name, args, status: 'running' } as ToolCallEvent,
      });
      if (abortSignal?.aborted) return [{ id, name, args, status: 'skipped' }];
      const settled = await Promise.allSettled([runOne(call)]);
      return [settleToOutcome(settled[0], describeCall(call))];
    }

    const outcomes: CallOutcome[] = [];
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
          toolCall: { id, name, args, status: 'running' } as ToolCallEvent,
        });
      }
      const settled = await Promise.allSettled(
        chunk.map((index: number): Promise<CallOutcome> => {
          if (abortSignal?.aborted) {
            const { id, name, args } = describeCall(toolCalls[index]);
            return Promise.resolve({ id, name, args, status: 'skipped' });
          }
          return runOne(toolCalls[index]);
        })
      );
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
      } as any);
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
        } as ToolCallEvent,
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
function settleToOutcome(
  settled: PromiseSettledResult<CallOutcome>,
  fallback: { id: string; name: string; args: string },
): CallOutcome {
  if (settled.status === 'fulfilled') return settled.value;
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

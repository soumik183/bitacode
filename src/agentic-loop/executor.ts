/**
 * Tool execution module for the agentic loop.
 *
 * Handles execution of tool calls including special handling for
 * sub-agents and proper abort signal management between tool calls.
 *
 * Independent calls run concurrently in small chunks; results are always
 * applied in the original tool_calls order so provider history stays valid.
 */

import type { AgentEventHandler, ToolCallEvent } from '../agentic-loop.js';
import { handleToolCall, truncateToolResult } from '../tools/index.js';
import { runSubAgent, type SubAgentProgressHandler } from '../sub-agent.js';
import { logger } from '../utils/logger.js';

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
}

/** Max independent tool calls launched at once within a chunk. */
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

/**
 * Execute all tool calls from an assistant message.
 *
 * Handles:
 * - Bounded concurrent execution of independent calls (chunks of CONCURRENCY)
 * - Abort checking between chunks and between individual calls in a chunk
 * - Sub-agent special case with progress reporting
 * - Result application in original tool_calls order + pending-call stubs on abort
 *
 * Returns true if execution completed normally, false if aborted.
 */
export async function executeToolCalls(
  toolCalls: any[],
  messages: any[],
  onEvent: AgentEventHandler,
  context: ToolExecutionContext
): Promise<{ completed: boolean; shouldAbort: boolean }> {
  const { sessionId, abortSignal, requestDefaults, client, model, pricing } = context;

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
      let result: string;

      // Handle sub-agent tool specially
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
        result = truncateToolResult(subResult.response);
        // Emit sub-agent usage for the UI to add to total cost
        if (subResult.usage.inputTokens > 0 || subResult.usage.outputTokens > 0) {
          onEvent({
            type: 'sub_agent_iteration',
            subAgentUsage: subResult.usage as any,
          });
        }
      } else {
        result = await handleToolCall(name, args, { sessionId, abortSignal });
      }

      // Guarantee a bounded string payload whatever the tool returned.
      result = truncateToolResult(result);

      logger.info('Tool completed', {
        tool: name,
        resultLength: result.length,
      });

      return { id, name, args: argsStr, status: 'done', content: result, result };
    } catch (err) {
      const errMsg = String(err instanceof Error ? err.message : err);
      const aborted = Boolean(abortSignal?.aborted)
        || (err instanceof Error && (err.name === 'AbortError' || err.message === 'Operation aborted'));
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

  for (let start = 0; start < toolCalls.length; start += CONCURRENCY) {
    // Check abort before starting each chunk
    if (abortSignal?.aborted) {
      logger.debug('Agentic loop aborted between tool calls');
      injectStubsForPendingToolCalls();
      return { completed: false, shouldAbort: true };
    }

    const chunk = toolCalls.slice(start, start + CONCURRENCY);

    // Emit running events for the whole chunk before launching any call
    for (const toolCall of chunk) {
      const { id, name, args } = describeCall(toolCall);
      onEvent({
        type: 'tool_call',
        toolCall: { id, name, args, status: 'running' } as ToolCallEvent,
      });
    }

    // Launch calls concurrently; check abort before each individual call.
    const settled = await Promise.allSettled(
      chunk.map((toolCall: any): Promise<CallOutcome> => {
        if (abortSignal?.aborted) {
          const { id, name, args } = describeCall(toolCall);
          return Promise.resolve({ id, name, args, status: 'skipped' });
        }
        return runOne(toolCall);
      })
    );

    // Apply results in original tool_calls order, regardless of finish order.
    let aborted = false;
    for (let j = 0; j < chunk.length; j++) {
      const { id, name, args } = describeCall(chunk[j]);
      const settledResult = settled[j];
      const outcome: CallOutcome = settledResult.status === 'fulfilled'
        ? settledResult.value
        : {
            id, name, args, status: 'error',
            content: truncateToolResult(`Error: ${String(settledResult.reason)}`),
            result: String(settledResult.reason),
          };

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

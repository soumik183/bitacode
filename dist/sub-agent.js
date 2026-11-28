/**
 * Sub-agents — Spawn isolated child agent sessions.
 *
 * Sub-agents prevent context pollution by running tasks in a separate
 * message history. The parent agent delegates a task, the sub-agent
 * executes it with its own tool calls, and returns a summary.
 *
 * This is exposed as a `sub_agent` tool that the main agent can call.
 * `task` runs one child; `tasks` fans out several children in parallel.
 */
import crypto from 'node:crypto';
import { handleToolCall, getVisibleTools } from './tools/index.js';
import { BUILTIN_AGENTS, discoverAgents, resolveAgentSelection, applyAgentTools } from './agents.js';
import { generateSystemPrompt } from './system-prompt.js';
import { logger } from './utils/logger.js';
import { clearTodos } from './tools/todo.js';
import { calculateCost } from './utils/cost-tracker.js';
import { saveSubAgentRun, loadSubAgentRun, isValidSubAgentId, } from './utils/subagent-store.js';
import { sanitizeMessagesForProvider } from './utils/message-sanitize.js';
/** Default concurrent children for a `tasks` fan-out. */
const FANOUT_CAP = 3;
/** Hard ceiling for the fan-out concurrency cap. */
const MAX_FANOUT_CAP = 5;
/** Soft total iteration budget shared by all children of one fan-out. */
const FANOUT_ITERATION_BUDGET = 500;
/**
 * Live children, keyed by their persisted transcript id. The main agent can
 * list or abort them through the `subagent_control` tool. Entries are removed
 * in the child's `finally` block, so a stale controller can never linger.
 */
const runningChildren = new Map();
export function listRunningSubAgentIds() {
    return [...runningChildren.keys()];
}
export function isSubAgentRunning(id) {
    return runningChildren.has(id);
}
export function abortSubAgentRun(id) {
    const controller = runningChildren.get(id);
    if (!controller)
        return false;
    controller.abort();
    return true;
}
export const subAgentTool = {
    type: 'function',
    function: {
        name: 'sub_agent',
        description: 'Spawn isolated sub-agents to handle tasks without polluting the main conversation context. ' +
            'Use `task` for a single child, or `tasks` (an array) to run several independent subtasks in parallel. ' +
            'Good for exploring a codebase, researching a question, or making changes to a separate area. ' +
            'Each child has access to the same tools but runs in its own conversation.',
        parameters: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: 'A detailed description of the task for the sub-agent to complete. Use instead of `tasks`.',
                },
                tasks: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Multiple independent tasks to run in parallel (bounded concurrency). Use instead of `task`.',
                },
                max_iterations: {
                    type: 'number',
                    description: 'Maximum tool-call iterations shared across all children. Defaults to 500.',
                },
                agent_type: {
                    type: 'string',
                    // Keep the advertised enum aligned with the agents users can actually
                    // define in .bitacode/agents/ (and the built-in set).
                    enum: BUILTIN_AGENTS.map((agent) => agent.name),
                    description: 'Specialization for the sub-agent. Defaults to general.',
                },
                thoroughness: {
                    type: 'string',
                    enum: ['quick', 'medium', 'very thorough'],
                    description: 'How deeply the sub-agent should investigate. "quick" caps iterations. Defaults to medium.',
                },
            },
            anyOf: [{ required: ['task'] }, { required: ['tasks'] }],
        },
    },
};
/** Extra instructions appended to the system prompt for `Review` sub-agents. */
export const SUB_AGENT_REVIEW_MODE = `## Review Mode

You are a code reviewer. Review the code and report what you find.
Return findings as a concise list with severity (critical/high/medium/low) and file:line references.
Prefer read-only tools: read_file, glob, grep, list_directory, and bash for git diff.
Do NOT edit files unless the task explicitly asks you to.
Do NOT ask the user questions — work autonomously with the tools available.
End with a short verdict summarizing the overall assessment.`;
/**
 * Build a sub-agent system prompt: the base prompt plus Sub-Agent Mode,
 * with an extra review block when the child is a `Review` agent. Pure.
 */
export function buildSubAgentSystemPrompt(baseSystemPrompt, agentType) {
    const prompt = `${baseSystemPrompt}

## Sub-Agent Mode

You are running as a sub-agent. You were given a specific task by the parent agent.
Complete the task thoroughly and return a clear, concise summary of what you did and found.
Do NOT ask the user questions — work autonomously with the tools available.`;
    return agentType === 'Review' ? `${prompt}\n\n${SUB_AGENT_REVIEW_MODE}` : prompt;
}
/**
 * Main-agent control surface for sub-agents. The user never drives this; the
 * model calls it to list, inspect, continue, release or abort child sessions.
 */
export const subagentControlTool = {
    type: 'function',
    function: {
        name: 'subagent_control',
        description: 'Control sub-agent sessions owned by this main session. `list` shows all saved and running children; ' +
            '`status` shows one session; `prompt` continues a saved child with a new task and full prior context; ' +
            '`release` closes a child (it can no longer be prompted); `abort` stops a running child by id. ' +
            'Use the transcript id from progress events or `list` as `id`.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'status', 'prompt', 'release', 'abort'],
                    description: 'The control action to perform.',
                },
                id: { type: 'string', description: 'Sub-agent transcript id, required for status/prompt/release/abort.' },
                prompt: { type: 'string', description: 'Follow-up task for the child. Required for `prompt`.' },
            },
            required: ['action'],
        },
    },
};
/**
 * Run `tasks` with bounded concurrency using `Promise.allSettled`.
 *
 * Pure with respect to the LLM loop: callers supply the `runner`. Results
 * come back in input order; tasks not reached before abort are `skipped`.
 */
export async function runParallel(tasks, runner, cap = FANOUT_CAP, signal) {
    const effectiveCap = Number.isFinite(cap) ? Math.max(1, Math.min(Math.floor(cap), MAX_FANOUT_CAP)) : FANOUT_CAP;
    const results = new Array(tasks.length);
    for (let start = 0; start < tasks.length; start += effectiveCap) {
        if (signal?.aborted)
            break;
        const chunk = tasks.slice(start, start + effectiveCap);
        const settled = await Promise.allSettled(chunk.map((task, offset) => {
            const index = start + offset;
            if (signal?.aborted) {
                return Promise.reject(new Error('aborted'));
            }
            return runner(task, index, `sa-${index + 1}`);
        }));
        settled.forEach((outcome, offset) => {
            const index = start + offset;
            results[index] = {
                task: chunk[offset],
                index,
                id: `sa-${index + 1}`,
                status: outcome.status,
                ...(outcome.status === 'fulfilled' ? { value: outcome.value } : { reason: outcome.reason }),
            };
        });
    }
    // An abort can stop us before later chunks run — mark them skipped so the
    // caller gets a result per task.
    for (let i = 0; i < results.length; i++) {
        if (results[i])
            continue;
        results[i] = { task: tasks[i], index: i, id: `sa-${i + 1}`, status: 'skipped' };
    }
    return results;
}
/** Sum usage across children into a single combined usage object. */
function addUsage(total, usage) {
    total.inputTokens += usage.inputTokens || 0;
    total.outputTokens += usage.outputTokens || 0;
    total.totalTokens += usage.totalTokens || usage.inputTokens + usage.outputTokens;
    total.estimatedCost += usage.estimatedCost || 0;
}
/** Build one combined result with a labelled section per task. */
function combineResults(tasks, results) {
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
    const sections = results.map((result) => {
        const header = `## Task ${result.index + 1} (${result.id}): ${result.task}`;
        if (result.status === 'fulfilled' && result.value) {
            addUsage(usage, result.value.usage);
            return `${header}\n${result.value.response}`;
        }
        if (result.status === 'skipped') {
            return `${header}\n(skipped: aborted)`;
        }
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return `${header}\n(Error: ${reason})`;
    });
    return { response: sections.join('\n\n---\n\n'), usage };
}
/** Run a single child with its own isolated conversation (the original loop). */
async function runSubAgentOnce(client, model, task, maxIterations, requestDefaults, onProgress, abortSignal, pricing, agentType, thoroughness, sessionId, label, seedMessages, continueId, parentId) {
    const requestedIterations = Number(maxIterations);
    let iterationLimit = Number.isFinite(requestedIterations)
        ? Math.min(Math.max(Math.floor(requestedIterations), 1), 500)
        : 500;
    // These are advisory only: validate, log unknowns, and apply just the quick budget.
    const knownAgentsResult = discoverAgents();
    const registry = knownAgentsResult.ok ? knownAgentsResult.value : BUILTIN_AGENTS;
    const validTypes = registry.map((agent) => agent.name);
    if (agentType != null && !validTypes.includes(agentType)) {
        logger.warn('Sub-agent ignoring unknown agent_type', { agentType });
    }
    const validLevels = ['quick', 'medium', 'very thorough'];
    if (thoroughness != null && !validLevels.includes(thoroughness)) {
        logger.warn('Sub-agent ignoring unknown thoroughness', { thoroughness });
    }
    if (thoroughness === 'quick') {
        iterationLimit = Math.min(iterationLimit, 50);
    }
    logger.debug('Sub-agent configured', { agentType: agentType ?? 'general-purpose', thoroughness: thoroughness ?? 'medium', iterationLimit });
    const op = logger.startOperation('sub-agent');
    const startedAt = Date.now();
    const subAgentSessionId = continueId ?? `sub-agent-${crypto.randomUUID()}`;
    // Own the child's cancellation so the main agent can abort a specific run by
    // id, while a parent abort still propagates to every child.
    const childController = new AbortController();
    const childSignal = childController.signal;
    runningChildren.set(subAgentSessionId, childController);
    const forwardAbort = () => childController.abort();
    abortSignal?.addEventListener('abort', forwardAbort, { once: true });
    const systemPrompt = await generateSystemPrompt();
    let subSystemPrompt = buildSubAgentSystemPrompt(systemPrompt, agentType);
    // Named agents (`.bitacode/agents/*.md`) layer their instructions and tool
    // policy onto the child. Discovery is fail-safe: one bad file is logged by
    // the loader and never prevents the child from running.
    const agentRegistry = knownAgentsResult.ok ? knownAgentsResult.value : BUILTIN_AGENTS;
    const selectedAgent = resolveAgentSelection(agentType, [...agentRegistry]);
    if (selectedAgent.prompt) {
        subSystemPrompt += `\n\n## Agent: ${selectedAgent.name}\n${selectedAgent.prompt}`;
    }
    const visibleTools = getVisibleTools();
    const allowedNames = new Set(applyAgentTools(selectedAgent, visibleTools.map((tool) => tool.function.name)));
    const childTools = visibleTools.filter((tool) => allowedNames.has(tool.function.name));
    if (selectedAgent.model && selectedAgent.model !== model) {
        // Model overrides are advisory: the child inherits the parent's provider
        // credentials, so silently switching models could use the wrong account.
        logger.debug('Sub-agent ignored agent model override', { agent: selectedAgent.name, model: selectedAgent.model });
    }
    // A follow-up run starts from the saved transcript, then appends the new task
    // as a fresh user turn. The original record stays untouched; this one links
    // back to it through `parentId`.
    const messages = seedMessages
        ? [...seedMessages, { role: 'user', content: task }]
        : [
            { role: 'system', content: subSystemPrompt },
            { role: 'user', content: task },
        ];
    // Track cumulative usage across all API calls in the sub-agent
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    const usageNow = () => ({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        estimatedCost: totalCost,
    });
    let finalResult = { response: '', usage: usageNow() };
    let finalError;
    /** Record the outcome at every return point so the transcript matches the result. */
    const finish = (response) => {
        finalResult = { response, usage: usageNow() };
        return finalResult;
    };
    try {
        for (let i = 0; i < iterationLimit; i++) {
            // Check abort at the top of each iteration
            if (childSignal.aborted) {
                return finish('(sub-agent aborted)');
            }
            let assistantMessage;
            let hasToolCalls = false;
            try {
                const stream = await client.chat.completions.create({
                    ...requestDefaults,
                    model,
                    messages: sanitizeMessagesForProvider(messages),
                    tools: childTools,
                    tool_choice: 'auto',
                    stream: true,
                    stream_options: { include_usage: true },
                }, { signal: childSignal });
                // Accumulate the streamed response
                assistantMessage = {
                    role: 'assistant',
                    content: '',
                    tool_calls: [],
                };
                let streamedContent = '';
                hasToolCalls = false;
                let actualUsage;
                for await (const chunk of stream) {
                    const delta = chunk.choices[0]?.delta;
                    if (chunk.usage) {
                        actualUsage = chunk.usage;
                    }
                    // Stream text content
                    if (delta?.content) {
                        streamedContent += delta.content;
                        assistantMessage.content = streamedContent;
                    }
                    // Accumulate tool calls across stream chunks
                    if (delta?.tool_calls) {
                        hasToolCalls = true;
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!assistantMessage.tool_calls[idx]) {
                                assistantMessage.tool_calls[idx] = {
                                    id: '',
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                };
                            }
                            if (tc.id)
                                assistantMessage.tool_calls[idx].id = tc.id;
                            if (tc.function?.name) {
                                assistantMessage.tool_calls[idx].function.name += tc.function.name;
                            }
                            if (tc.function?.arguments) {
                                assistantMessage.tool_calls[idx].function.arguments += tc.function.arguments;
                            }
                        }
                    }
                }
                // Accumulate usage for this iteration
                const iterationInputTokens = actualUsage?.prompt_tokens || 0;
                const iterationOutputTokens = actualUsage?.completion_tokens || 0;
                const iterationCachedTokens = actualUsage?.prompt_tokens_details?.cached_tokens || 0;
                totalInputTokens += iterationInputTokens;
                totalOutputTokens += iterationOutputTokens;
                // Calculate cost if pricing is available (handles cached token discount)
                if (pricing && (iterationInputTokens > 0 || iterationOutputTokens > 0)) {
                    totalCost += calculateCost(iterationInputTokens, iterationOutputTokens, pricing, iterationCachedTokens);
                }
            }
            catch (err) {
                // If aborted during streaming, return gracefully
                if (childSignal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.message === 'Operation aborted'))) {
                    logger.debug('Sub-agent aborted during streaming');
                    return finish('(sub-agent aborted)');
                }
                throw err;
            }
            const message = assistantMessage;
            if (!message)
                break;
            // Check for tool calls
            if (hasToolCalls && assistantMessage.tool_calls.length > 0) {
                // Clean up empty tool_calls entries (from sparse array)
                assistantMessage.tool_calls = assistantMessage.tool_calls.filter(Boolean);
                // Filter out tool calls with malformed JSON arguments (can happen if stream aborted mid-tool-call)
                assistantMessage.tool_calls = assistantMessage.tool_calls.filter((tc) => {
                    const args = tc.function?.arguments;
                    if (!args)
                        return true; // No args is valid
                    try {
                        JSON.parse(args);
                        return true;
                    }
                    catch {
                        logger.warn('Filtering out sub-agent tool call with malformed JSON', {
                            tool: tc.function?.name,
                            argsPreview: args.slice(0, 100),
                        });
                        return false;
                    }
                });
                // Only add message if we have valid tool calls
                if (assistantMessage.tool_calls.length === 0) {
                    hasToolCalls = false;
                }
                else {
                    messages.push(message);
                }
                for (const toolCall of assistantMessage.tool_calls) {
                    // Check abort between tool calls
                    if (childSignal.aborted) {
                        return finish('(sub-agent aborted)');
                    }
                    const { name, arguments: argsStr } = toolCall.function;
                    let args;
                    try {
                        args = JSON.parse(argsStr);
                    }
                    catch {
                        args = {};
                    }
                    logger.debug(`Sub-agent tool call: ${name}`, { args });
                    onProgress?.({ tool: name, status: 'running', iteration: i, args });
                    try {
                        const result = await handleToolCall(name, args, { sessionId: subAgentSessionId, abortSignal: childSignal });
                        messages.push({
                            role: 'tool',
                            name,
                            tool_call_id: toolCall.id,
                            content: result,
                        });
                        onProgress?.({ tool: name, status: 'done', iteration: i });
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        messages.push({
                            role: 'tool',
                            name,
                            tool_call_id: toolCall.id,
                            content: `Error: ${msg}`,
                        });
                        onProgress?.({ tool: name, status: 'error', iteration: i });
                    }
                }
                continue;
            }
            // Plain text response — we're done
            if (message.content) {
                messages.push({
                    role: 'assistant',
                    content: message.content,
                });
                return finish(message.content);
            }
            // The model produced an empty text response (e.g. it only called tools
            // and issued no final summary).  Log it and return a sentinel so the
            // parent agent knows the sub-agent finished but had nothing to say.
            logger.debug('Sub-agent returned empty content', { iteration: i });
            return finish('(sub-agent completed with no response)');
        }
        return finish('(sub-agent reached iteration limit)');
    }
    catch (err) {
        finalError = err instanceof Error ? err.message : String(err);
        throw err;
    }
    finally {
        if (sessionId) {
            try {
                const status = finalError
                    ? 'error'
                    : finalResult.response === '(sub-agent aborted)'
                        ? 'aborted'
                        : finalResult.response === '(sub-agent reached iteration limit)'
                            ? 'iteration_limit'
                            : 'done';
                await saveSubAgentRun({
                    sessionId,
                    id: subAgentSessionId,
                    task,
                    label,
                    agentType,
                    ...(parentId ? { parentId } : {}),
                    status,
                    startedAt,
                    endedAt: Date.now(),
                    messages,
                    usage: finalResult.usage,
                    ...(finalError ? { error: finalError } : {}),
                });
            }
            catch (err) {
                // Persistence is best-effort — never change the child's result.
                logger.warn('Sub-agent transcript persistence failed', { id: subAgentSessionId, err: String(err) });
            }
        }
        runningChildren.delete(subAgentSessionId);
        abortSignal?.removeEventListener('abort', forwardAbort);
        op.end();
        clearTodos(subAgentSessionId);
    }
}
/**
 * Run one or more sub-agents with isolated conversations.
 *
 * A string `task` preserves the original single-child behavior. An array
 * `tasks` fans out with bounded concurrency, a shared iteration budget, and
 * per-child progress events carrying stable `sa-N` ids.
 *
 * Returns one combined result: a labelled section per child and usage summed
 * across all children (so the executor can keep emitting a single usage event).
 */
export async function runSubAgent(client, model, task, maxIterations = 500, requestDefaults = {}, onProgress, abortSignal, pricing, agentType, thoroughness, sessionId) {
    const tasks = Array.isArray(task) ? task : [task];
    const isFanOut = tasks.length > 1;
    // `max_iterations` is a shared budget across the fan-out, soft-capped so
    // N children cannot each burn the full 500 iterations. Single tasks are
    // unaffected.
    const requested = Number(maxIterations);
    const baseLimit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.floor(requested), 1), 500)
        : 500;
    const perChildIterations = isFanOut
        ? Math.max(1, Math.min(baseLimit, Math.floor(FANOUT_ITERATION_BUDGET / tasks.length)))
        : baseLimit;
    const results = await runParallel(tasks, (childTask, index, id) => {
        const label = `Task ${index + 1}/${tasks.length}`;
        const persistedId = `sub-agent-${crypto.randomUUID()}`;
        const childProgress = (evt) => onProgress?.({
            ...evt, subAgentId: id, subAgentTranscriptId: persistedId,
            subAgentLabel: label, subAgentTask: childTask,
        });
        onProgress?.({
            tool: 'sub_agent', status: 'running', iteration: 0,
            subAgentId: id, subAgentTranscriptId: persistedId,
            subAgentLabel: label, subAgentStatus: 'start', subAgentTask: childTask,
            subAgentType: agentType,
        });
        return runSubAgentOnce(client, model, childTask, perChildIterations, requestDefaults, childProgress, abortSignal, pricing, agentType, thoroughness, sessionId, label, undefined, persistedId).then((result) => {
            onProgress?.({
                tool: 'sub_agent', status: 'done', iteration: 0,
                subAgentId: id, subAgentTranscriptId: persistedId, subAgentLabel: label, subAgentStatus: 'done',
                subAgentTask: childTask, args: { ...result.usage }, subAgentType: agentType,
            });
            return result;
        }, (err) => {
            onProgress?.({
                tool: 'sub_agent', status: 'error', iteration: 0,
                subAgentId: id, subAgentTranscriptId: persistedId, subAgentLabel: label, subAgentStatus: 'error',
                subAgentTask: childTask,
                args: { error: err instanceof Error ? err.message : String(err) }, subAgentType: agentType,
            });
            throw err;
        });
    }, FANOUT_CAP, abortSignal);
    return combineResults(tasks, results);
}
/** Rebuild provider-safe history from a persisted transcript. */
function seedFromRecord(messages) {
    const recent = messages.slice(-80);
    const system = messages.find((message) => message.role === 'system');
    if (system && recent[0]?.role !== 'system')
        recent.unshift(system);
    const seed = [];
    for (const message of recent) {
        const role = message.role;
        if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool')
            continue;
        if (role === 'tool') {
            if (!message.tool_call_id || !message.content)
                continue;
            // `name` is not valid on a provider tool message; the call already has it.
            seed.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
            continue;
        }
        if (role === 'assistant' && message.tool_calls?.length) {
            seed.push({
                role: 'assistant',
                content: message.content,
                tool_calls: message.tool_calls.map((call) => ({
                    id: call.id ?? `call-${crypto.randomUUID()}`,
                    type: 'function',
                    function: {
                        name: call.function?.name ?? 'unknown',
                        arguments: call.function?.arguments ?? '{}',
                    },
                })),
            });
            continue;
        }
        if (!message.content)
            continue;
        seed.push({ role, content: message.content });
    }
    return seed;
}
/**
 * Continue a saved sub-agent with a new prompt from the main agent. The child
 * sees its own prior transcript plus the new task; a new record is saved and
 * linked to the original so either can still be inspected on its own.
 */
export async function runSubAgentFollowUp(client, model, sessionId, parentId, prompt, options = {}) {
    if (!isValidSubAgentId(sessionId) || !isValidSubAgentId(parentId)) {
        logger.warn('Sub-agent follow-up rejected invalid id', { sessionId, parentId });
        return null;
    }
    const record = await loadSubAgentRun(sessionId, parentId);
    if (!record) {
        logger.warn('Sub-agent follow-up could not load parent', { sessionId, parentId });
        return null;
    }
    const task = String(prompt ?? '').trim();
    if (!task)
        return null;
    const id = `sub-agent-${crypto.randomUUID()}`;
    const onProgress = options.onProgress;
    onProgress?.({
        tool: 'sub_agent', status: 'running', iteration: 0,
        subAgentId: id, subAgentTranscriptId: id, subAgentStatus: 'start',
        subAgentLabel: 'Continue', subAgentTask: task,
    });
    try {
        const result = await runSubAgentOnce(client, model, task, options.maxIterations, options.requestDefaults ?? {}, onProgress, options.abortSignal, options.pricing, record.agentType, undefined, sessionId, 'Continue', seedFromRecord(record.messages), id, parentId);
        onProgress?.({
            tool: 'sub_agent', status: 'done', iteration: 0,
            subAgentId: id, subAgentTranscriptId: id, subAgentStatus: 'done',
            subAgentLabel: 'Continue', subAgentTask: task, args: { ...result.usage },
        });
        return result;
    }
    catch (err) {
        onProgress?.({
            tool: 'sub_agent', status: 'error', iteration: 0,
            subAgentId: id, subAgentTranscriptId: id, subAgentStatus: 'error',
            subAgentLabel: 'Continue', subAgentTask: task,
            args: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
    }
}

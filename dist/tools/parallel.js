import { cap, errorMessage, MAX_PARALLEL_CALLS, MAX_PARALLEL_CONCURRENCY, MAX_SINGLE_RESULT_CHARS, } from './task-registry.js';
let parallelExecutor = null;
/**
 * Wire the dispatcher here, e.g.
 * `setParallelExecutor((name, args, ctx) => handleToolCall(name, args, ctx))`.
 * Pass null to clear (used by tests).
 */
export function setParallelExecutor(fn) {
    parallelExecutor = fn;
}
export const parallelTool = {
    type: 'function',
    function: {
        name: 'parallel',
        description: `Run up to ${MAX_PARALLEL_CALLS} independent tool calls concurrently (${MAX_PARALLEL_CONCURRENCY} at a time). Results keep the original order.`,
        parameters: {
            type: 'object',
            properties: {
                calls: {
                    type: 'array',
                    description: 'Tool calls to run. Each has a tool name and an arguments object.',
                    maxItems: MAX_PARALLEL_CALLS,
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Name of the tool to call.' },
                            arguments: { type: 'object', description: 'Arguments for that tool.' },
                        },
                        required: ['name'],
                    },
                },
            },
            required: ['calls'],
        },
    },
};
export async function runParallel(args = {}, context = {}) {
    try {
        const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        if (!Array.isArray(a.calls))
            return 'Error: calls must be an array of { name, arguments } objects.';
        if (a.calls.length > MAX_PARALLEL_CALLS) {
            return `Error: too many parallel calls (${a.calls.length}); the limit is ${MAX_PARALLEL_CALLS}.`;
        }
        const calls = [];
        for (let i = 0; i < a.calls.length; i++) {
            const raw = a.calls[i];
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return `Error: call at index ${i} must be an object.`;
            }
            const call = raw;
            const name = typeof call.name === 'string' ? call.name.trim() : '';
            if (!name)
                return `Error: call at index ${i} is missing a non-empty "name".`;
            const callArgs = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
                ? call.arguments
                : {};
            calls.push({ name, arguments: callArgs });
        }
        const exec = parallelExecutor;
        if (!exec) {
            return 'Error: parallel executor is not configured; call setParallelExecutor(fn) to wire the tool dispatcher.';
        }
        const results = new Array(calls.length);
        for (let offset = 0; offset < calls.length; offset += MAX_PARALLEL_CONCURRENCY) {
            const batch = calls.slice(offset, offset + MAX_PARALLEL_CONCURRENCY);
            const settled = await Promise.allSettled(batch.map(async (call) => await exec(call.name, call.arguments, context)));
            settled.forEach((outcome, index) => {
                const value = outcome.status === 'fulfilled'
                    ? String(outcome.value)
                    : `Error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`;
                results[offset + index] = cap(value.slice(0, MAX_SINGLE_RESULT_CHARS), MAX_SINGLE_RESULT_CHARS);
            });
        }
        const lines = calls.map((call, i) => `${i + 1}. [${call.name}] ${results[i]}`);
        return cap(`Parallel results (${calls.length}):\n${lines.join('\n')}`);
    }
    catch (err) {
        return errorMessage('parallel', err);
    }
}

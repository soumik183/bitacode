/**
 * tool-repetition.ts — doom-loop guard.
 *
 * Models occasionally repeat the exact same call (same tool, same arguments)
 * until the iteration cap, burning tokens and time. This counts identical calls
 * within one turn (the caller owns the map) and flags the call after a small
 * threshold. Polling/meta tools are exempt: repeating them is the whole point.
 */
/** Tools whose repeated calls are expected and must never be blocked. */
const EXEMPT_TOOLS = new Set([
    'poll_process',
    'todo_read',
    'agent_status',
    'task_result',
    'progress',
    'read_subagent',
    'subagent_control',
]);
export const DEFAULT_MAX_IDENTICAL_CALLS = 3;
/** Stable, order-insensitive key for a tool + arguments pair. */
export function repetitionKey(name, args) {
    try {
        const value = args && typeof args === 'object' && !Array.isArray(args)
            ? Object.keys(args)
                .sort()
                .reduce((acc, key) => {
                acc[key] = args[key];
                return acc;
            }, {})
            : args;
        return `${name}\u0000${JSON.stringify(value ?? null)}`;
    }
    catch {
        return `${name}\u0000?`;
    }
}
/**
 * Record a call and return true when it has now repeated too often within the
 * caller's turn. The map is mutated in place (copy-on-write is unnecessary:
 * the caller owns one map per turn).
 */
export function shouldBlockRepetition(name, args, counts, maxIdentical = DEFAULT_MAX_IDENTICAL_CALLS) {
    if (EXEMPT_TOOLS.has(name))
        return false;
    const key = repetitionKey(name, args);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next > Math.max(1, maxIdentical);
}

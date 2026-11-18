/**
 * read_subagent — inspect child-agent transcripts saved during this session.
 *
 * Read-only and approval-free: every path goes through the store, which
 * validates ids so the main agent can never traverse outside the store dir.
 */
import { listSubAgentRuns, loadSubAgentRun, isValidSubAgentId } from '../utils/subagent-store.js';
const MAX_OUTPUT_CHARS = 20_000;
function cap(text) {
    return text.length <= MAX_OUTPUT_CHARS
        ? text
        : `${text.slice(0, MAX_OUTPUT_CHARS - 20)}\n… [truncated]`;
}
export const readSubagentTool = {
    type: 'function',
    function: {
        name: 'read_subagent',
        description: 'Read transcripts of sub-agents spawned in a session. Omit id to list runs (id, status, task, summary); pass id to read one transcript. Set include_messages to false for metadata only.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'Main session id. Defaults to the current session.',
                },
                id: {
                    type: 'string',
                    description: 'Sub-agent run id. Omit to list all runs in the session.',
                },
                include_messages: {
                    type: 'boolean',
                    description: 'When reading one run, include its message transcript. Defaults to true.',
                },
            },
            required: [],
        },
    },
};
/**
 * Returns a compact text summary, a full transcript, or a clear `Error: ...`
 * string. Never throws.
 */
export async function readSubagent(args = {}, context = {}) {
    try {
        const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const requestedSession = typeof a.session_id === 'string' && a.session_id.trim()
            ? a.session_id.trim()
            : context.sessionId;
        if (!isValidSubAgentId(requestedSession)) {
            return `Error: invalid or missing session_id${typeof a.session_id === 'string' ? `: ${a.session_id}` : ''}.`;
        }
        const sessionId = requestedSession;
        const requestedId = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : undefined;
        if (requestedId && !isValidSubAgentId(requestedId)) {
            return `Error: invalid sub-agent id: ${requestedId}.`;
        }
        if (!requestedId) {
            const runs = await listSubAgentRuns(sessionId);
            if (runs.length === 0)
                return `No sub-agent runs recorded for session ${sessionId}.`;
            const lines = runs.map((run) => {
                const detail = run.error ? `error: ${run.error}` : `messages: ${run.messageCount}`;
                return `- ${run.id}  [${run.status}]  ${run.task}  (${detail})`;
            });
            return cap(`Sub-agent runs for session ${sessionId} (${runs.length}):\n${lines.join('\n')}\n` +
                'Pass id to read one transcript.');
        }
        const record = await loadSubAgentRun(sessionId, requestedId);
        if (!record)
            return `Error: sub-agent run ${requestedId} not found in session ${sessionId}.`;
        const header = [
            `id: ${record.id}`,
            `status: ${record.status}`,
            `task: ${record.task}`,
            `label: ${record.label ?? '-'}`,
            ...(record.usage
                ? [`usage: ${record.usage.inputTokens} in / ${record.usage.outputTokens} out, $${record.usage.estimatedCost.toFixed(4)}`]
                : []),
            ...(record.error ? [`error: ${record.error}`] : []),
        ].join('\n');
        if (a.include_messages === false)
            return cap(header);
        const transcript = record.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
        return cap(`${header}\n\nTRANSCRIPT\n${transcript || '(no messages)'}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error reading sub-agent transcript: ${msg}`;
    }
}

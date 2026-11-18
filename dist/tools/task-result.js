import { isValidSubAgentId, loadSubAgentRun } from '../utils/subagent-store.js';
import { cap, errorMessage, MAX_PREVIEW_CHARS, MAX_TRANSCRIPT_PREVIEW, } from './task-registry.js';
export const taskResultTool = {
    type: 'function',
    function: {
        name: 'task_result',
        description: 'Read a stored sub-agent result by id, including a short transcript summary. Never throws.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Sub-agent run id.' },
                session_id: { type: 'string', description: 'Main session id. Defaults to the current session.' },
            },
            required: ['id'],
        },
    },
};
export async function taskResult(args = {}, context = {}) {
    try {
        const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const id = typeof a.id === 'string' ? a.id.trim() : '';
        if (!isValidSubAgentId(id))
            return 'Error: invalid or missing sub-agent id.';
        const sessionId = typeof a.session_id === 'string' && a.session_id.trim()
            ? a.session_id.trim()
            : context.sessionId;
        if (!isValidSubAgentId(sessionId))
            return 'Error: invalid or missing session_id.';
        const record = await loadSubAgentRun(sessionId, id);
        if (!record)
            return `Error: sub-agent result "${id}" not found in session ${sessionId}.`;
        const roles = new Map();
        for (const message of record.messages)
            roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
        const roleSummary = [...roles.entries()].map(([role, count]) => `${role}: ${count}`).join(', ') || 'none';
        const preview = record.messages.slice(-MAX_TRANSCRIPT_PREVIEW)
            .map((message) => `  ${message.role}: ${message.content.slice(0, MAX_PREVIEW_CHARS)}`)
            .join('\n');
        const omitted = record.messages.length - Math.min(MAX_TRANSCRIPT_PREVIEW, record.messages.length);
        const header = [
            `Sub-agent result — ${record.id}`,
            `status: ${record.status}`,
            `task: ${record.task}`,
            `label: ${record.label ?? '-'}`,
            ...(record.usage
                ? [`usage: ${record.usage.inputTokens} in / ${record.usage.outputTokens} out, $${record.usage.estimatedCost.toFixed(4)}`]
                : []),
            ...(record.error ? [`error: ${record.error}`] : []),
            `messages: ${record.messages.length} (${roleSummary})`,
        ].join('\n');
        return cap(`${header}\n\nTRANSCRIPT SUMMARY\n${preview || '  (no messages)'}${omitted ? `\n  … ${omitted} earlier messages omitted` : ''}`);
    }
    catch (err) {
        return errorMessage('task_result', err);
    }
}

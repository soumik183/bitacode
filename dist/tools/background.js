/** background tool — start a long-running command in the background. */
import { startProcess } from './process.js';
import { errorMessage } from './system-helpers.js';
export const backgroundTool = {
    type: 'function',
    function: {
        name: 'background',
        description: 'Start a long-running command in the background. Alias of start_process; returns a process id.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to run in the background.' },
            },
            required: ['command'],
        },
    },
};
export async function background(command, sessionId) {
    try {
        return await startProcess(command, sessionId);
    }
    catch (err) {
        return `Error: ${errorMessage(err)}`;
    }
}

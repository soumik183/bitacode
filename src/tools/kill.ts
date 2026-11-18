/** kill tool — stop a process by numeric pid or by a background id. */

import { stopProcess } from './process.js';
import { errorMessage, requestApprovalOrMessage } from './system-helpers.js';

export const killTool = {
  type: 'function' as const,
  function: {
    name: 'kill',
    description:
      'Stop a process by numeric pid or by a background id returned by start_process/background. ' +
      'Sends SIGTERM, then SIGKILL if still alive. Arbitrary pids require approval.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Positive process id to terminate.' },
        id: { type: 'string', description: 'Background process id returned by start_process or background.' },
      },
      required: [],
    },
  },
};

export async function kill(pid?: number, id?: string, sessionId?: string): Promise<string> {
  try {
    if ((pid === undefined) === (id === undefined)) {
      return 'Error: provide exactly one of pid or id.';
    }

    // Managed background ids are stopped via the process tool's existing logic.
    if (id !== undefined) {
      if (typeof id !== 'string' || id.trim() === '') return 'Error: id must be a non-empty string.';
      return stopProcess(id);
    }

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return 'Error: pid must be a positive integer.';
    }
    if (pid === process.pid) return 'Error: refusing to kill the current process (self).';

    const denial = await requestApprovalOrMessage({
      id: `kill-${Date.now()}`,
      type: 'shell_command',
      description: `Terminate process ${pid}`,
      detail: `Process id: ${pid}\nSignal: SIGTERM, then SIGKILL after 2s if still alive.`,
      sessionId,
      sessionScopeKey: `kill:${pid}`,
    }, `Kill cancelled by user: ${pid}`);
    if (denial !== null) return denial;

    try {
      process.kill(pid, 0);
    } catch (err) {
      return `Error: process ${pid} not found. ${errorMessage(err)}`;
    }

    process.kill(pid, 'SIGTERM');
    const timer = setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process exited after SIGTERM.
      }
    }, 2000);
    timer.unref?.();

    return `Sent SIGTERM to process ${pid}; will escalate to SIGKILL after 2s if still running.`;
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

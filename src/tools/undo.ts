/**
 * undo tool — restore files from the most recent checkpoint (or a given id).
 */

import { listCheckpoints, restoreCheckpoint } from '../utils/checkpoint.js';

export const undoTool = {
  type: 'function' as const,
  function: {
    name: 'undo',
    description:
      'Undo the last file modification by restoring files to the snapshot taken before it. ' +
      'Pass an id to restore a specific checkpoint from the current session.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional checkpoint id to restore. Defaults to the most recent one.' },
      },
      required: [],
    },
  },
};

export async function undo(id?: string, sessionId?: string): Promise<string> {
  try {
    if (typeof id === 'string' && id.trim()) {
      const restored = await restoreCheckpoint(id.trim(), sessionId);
      if (restored.length === 0) {
        return `No checkpoint with id "${id}" found in this session.`;
      }
      return `Undid checkpoint ${id}. Restored: ${restored.join(', ')}`;
    }

    const checkpoints = await listCheckpoints(sessionId);
    if (checkpoints.length === 0) {
      return 'Nothing to undo — no checkpoints in this session.';
    }

    const last = checkpoints[checkpoints.length - 1];
    const restored = await restoreCheckpoint(last.id, sessionId);
    if (restored.length === 0) {
      return 'Undo failed — the most recent checkpoint could not be restored.';
    }
    return `Undid changes from ${last.tool} to: ${restored.join(', ')}`;
  } catch (err) {
    return `Error: undo failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** move tool — move a file or directory, creating destination parent directories. */

import { relocate } from './file-helpers.js';

export const moveTool = {
  type: 'function' as const,
  function: {
    name: 'move',
    description: 'Move a file or directory, creating destination parent directories. Requires approval.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to move.' },
        destination: { type: 'string', description: 'Destination path.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing destination (default false).' },
      },
      required: ['source', 'destination'],
    },
  },
};

export async function movePath(
  source: unknown,
  destination: unknown,
  overwrite?: unknown,
  sessionId?: string,
): Promise<string> {
  return relocate('move', source, destination, overwrite, true, sessionId);
}

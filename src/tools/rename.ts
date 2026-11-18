/** rename tool — rename a file or directory. */

import { relocate } from './file-helpers.js';

export const renameTool = {
  type: 'function' as const,
  function: {
    name: 'rename',
    description: 'Rename a file or directory. Requires approval. Set overwrite: true to replace an existing destination.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to rename.' },
        destination: { type: 'string', description: 'New path.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing destination (default false).' },
      },
      required: ['source', 'destination'],
    },
  },
};

export async function renamePath(
  source: unknown,
  destination: unknown,
  overwrite?: unknown,
  sessionId?: string,
): Promise<string> {
  return relocate('rename', source, destination, overwrite, false, sessionId);
}

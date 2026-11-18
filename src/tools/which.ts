/** which tool — locate an executable by name using PATH. */

import { errorMessage, findExecutable, validateExecutableName } from './system-helpers.js';

export const whichTool = {
  type: 'function' as const,
  function: {
    name: 'which',
    description: 'Locate an executable by name using PATH. Returns its absolute path or a clear not-found message.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Executable name to locate (e.g. node).' },
      },
      required: ['name'],
    },
  },
};

export async function which(name: string): Promise<string> {
  try {
    const invalid = validateExecutableName(name);
    if (invalid) return invalid;
    return (await findExecutable(name)) ?? `Error: '${name}' not found in PATH.`;
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

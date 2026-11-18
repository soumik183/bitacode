/** command_exists tool — check whether an executable is available on PATH. */

import { errorMessage, findExecutable, validateExecutableName } from './system-helpers.js';

export const commandExistsTool = {
  type: 'function' as const,
  function: {
    name: 'command_exists',
    description: 'Check whether an executable is available on PATH. Returns true or false.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Executable name to check (e.g. node).' },
      },
      required: ['name'],
    },
  },
};

export async function commandExists(name: string): Promise<string> {
  try {
    const invalid = validateExecutableName(name);
    if (invalid) return invalid;
    return (await findExecutable(name)) ? 'true' : 'false';
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

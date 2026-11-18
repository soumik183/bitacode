/** mkdir tool — create a directory inside the working directory. */

import fs from 'node:fs/promises';
import { validatePath } from '../utils/path-validation.js';
import { asBoolean, pathExists, requireString, safe } from './file-helpers.js';

export const mkdirTool = {
  type: 'function' as const,
  function: {
    name: 'mkdir',
    description: 'Create a directory inside the working directory. No approval needed.',
    parameters: {
      type: 'object',
      properties: {
        directory_path: { type: 'string', description: 'Directory to create.' },
        recursive: { type: 'boolean', description: 'Create missing parent directories (default true).' },
      },
      required: ['directory_path'],
    },
  },
};

export async function makeDirectory(
  directoryPath: unknown,
  recursive?: unknown,
  _sessionId?: string,
): Promise<string> {
  return safe(async () => {
    const requested = requireString(directoryPath, 'directory_path');
    const validated = await validatePath(requested);
    if (await pathExists(validated)) {
      const stat = await fs.lstat(validated);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`'${requested}' exists and is not a directory.`);
      }
      return `Directory already exists: ${requested}.`;
    }
    await fs.mkdir(validated, { recursive: asBoolean(recursive, true) });
    return `Created directory ${requested}.`;
  });
}

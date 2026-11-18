/** stat tool — show file or directory metadata. */

import fs from 'node:fs/promises';
import { validatePath } from '../utils/path-validation.js';
import { errorCode, errorMessage, formatSize, requireString, safe } from './file-helpers.js';

export const statTool = {
  type: 'function' as const,
  function: {
    name: 'stat',
    description: 'Show file or directory metadata: type, size, permissions, modification time and symlink status.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to inspect.' },
      },
      required: ['file_path'],
    },
  },
};

export async function statPath(filePath: unknown, _sessionId?: string): Promise<string> {
  return safe(async () => {
    const requested = requireString(filePath, 'file_path');
    const validated = await validatePath(requested);
    let stat;
    try {
      stat = await fs.lstat(validated);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') throw new Error(`'${requested}': path not found.`);
      throw new Error(`'${requested}': cannot access path: ${errorMessage(err)}`);
    }

    const isSymlink = stat.isSymbolicLink();
    const type = isSymlink ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let linkTarget = '';
    if (isSymlink) {
      try {
        linkTarget = await fs.readlink(validated);
      } catch {
        // Best effort: the symlink itself is still reported.
      }
    }
    return [
      `Path: ${requested}`,
      `Type: ${type}${linkTarget ? ` -> ${linkTarget}` : ''}`,
      `Size: ${formatSize(stat.size)} (${stat.size} bytes)`,
      `Mode: ${(stat.mode & 0o7777).toString(8).padStart(4, '0')}`,
      `Modified: ${stat.mtime.toISOString()}`,
      `Symlink: ${isSymlink ? 'yes' : 'no'}`,
    ].join('\n');
  });
}

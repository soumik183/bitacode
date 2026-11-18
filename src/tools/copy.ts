/** copy tool — copy a file or directory. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';
import {
  approve,
  asBoolean,
  cancelled,
  errorCode,
  errorMessage,
  formatSize,
  pathExists,
  requireString,
  safe,
} from './file-helpers.js';

const MAX_COPY_BYTES = 20 * 1024 * 1024;

export const copyTool = {
  type: 'function' as const,
  function: {
    name: 'copy',
    description: 'Copy a file or directory. Requires approval. Directories need recursive: true; source is capped at 20 MB.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to copy.' },
        destination: { type: 'string', description: 'Destination path.' },
        recursive: { type: 'boolean', description: 'Copy directories recursively (default false).' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing destination (default false).' },
      },
      required: ['source', 'destination'],
    },
  },
};

async function assertCopySize(target: string, isDirectory: boolean): Promise<void> {
  if (!isDirectory) {
    const stat = await fs.stat(target);
    if (stat.size > MAX_COPY_BYTES) {
      throw new Error(`source is too large to copy (${formatSize(stat.size)}, limit ${formatSize(MAX_COPY_BYTES)}).`);
    }
    return;
  }

  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isDirectory()) stack.push(child);
      else total += stat.size;
      if (total > MAX_COPY_BYTES) {
        throw new Error(`source is too large to copy (over ${formatSize(MAX_COPY_BYTES)}).`);
      }
    }
  }
}

export async function copyPath(
  source: unknown,
  destination: unknown,
  recursive?: unknown,
  overwrite?: unknown,
  sessionId?: string,
): Promise<string> {
  return safe(async () => {
    const src = requireString(source, 'source');
    const dst = requireString(destination, 'destination');
    const srcValidated = await validatePath(src);
    const dstValidated = await validatePath(dst);
    if (srcValidated === dstValidated) throw new Error('source and destination are the same path.');

    let stat;
    try {
      stat = await fs.stat(srcValidated);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') throw new Error(`'${src}': source not found.`);
      throw new Error(`'${src}': cannot access source: ${errorMessage(err)}`);
    }
    const isDirectory = stat.isDirectory();
    const isRecursive = asBoolean(recursive);
    if (isDirectory && !isRecursive) {
      throw new Error(`'${src}' is a directory; pass recursive: true to copy it.`);
    }
    await assertCopySize(srcValidated, isDirectory);

    const canOverwrite = asBoolean(overwrite);
    if ((await pathExists(dstValidated)) && !canOverwrite) {
      throw new Error(`destination already exists: ${dst}. Pass overwrite: true to replace it.`);
    }

    const approved = await approve(
      'file_write',
      `Copy ${src} to ${dst}${isDirectory ? ' (recursive)' : ''}`,
      `From: ${srcValidated}\nTo: ${dstValidated}\nOverwrite: ${canOverwrite}`,
      `copy:${srcValidated}:${dstValidated}`,
      sessionId,
    );
    if (!approved) return cancelled(`copy of ${src}`);

    await fs.mkdir(path.dirname(dstValidated), { recursive: true });
    if (canOverwrite) await fs.rm(dstValidated, { recursive: true, force: true });
    await fs.cp(srcValidated, dstValidated, { recursive: isRecursive });
    return `Copied ${src} to ${dst}${isDirectory ? ' (directory)' : ''}.`;
  });
}

/**
 * read_image tool — read an image file as a base64 data URL.
 *
 * Validation is by extension and file size; the payload is capped so a large
 * image cannot flood the model context. No new dependencies.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';

export const readImageTool = {
  type: 'function' as const,
  function: {
    name: 'read_image',
    description:
      'Read an image file (.png, .jpg, .jpeg, .gif, .webp, .bmp) and return it as a base64 data URL ' +
      'with its mime type and size.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the image file (relative to working directory).' },
      },
      required: ['file_path'],
    },
  },
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 5 MB raw file cap (base64 output is ~1.33x this). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function readImage(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return 'Error: file_path is required.';
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return `Error: unsupported image type "${ext || '(none)'}". Expected one of: ${Object.keys(MIME_BY_EXT).join(', ')}.`;
  }

  if (filePath.includes('\0')) return 'Error: file_path contains a null byte.';

  try {
    // Same sandbox as every other file tool: `../outside.png` must not turn
    // into base64 bytes in the model context.
    const absolute = await validatePath(filePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return `Error: '${filePath}' is not a file.`;
    if (stat.size === 0) return `Error: '${filePath}' is empty.`;
    if (stat.size > MAX_IMAGE_BYTES) {
      return `Error: image is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`;
    }

    const buffer: Buffer = await fs.readFile(absolute);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return `Image: ${filePath}\nMIME: ${mime}\nSize: ${buffer.length} bytes\n${dataUrl}`;
  } catch (err) {
    return `Error: could not read image: ${err instanceof Error ? err.message : String(err)}`;
  }
}

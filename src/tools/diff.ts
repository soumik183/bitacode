/** diff tool — compare two files, or a file against literal text. */

import { validatePath } from '../utils/path-validation.js';
import { computeUnifiedDiff, readRegularFile, safe } from './file-helpers.js';

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;

export const diffTool = {
  type: 'function' as const,
  function: {
    name: 'diff',
    description:
      'Compare two files, or a file against literal text. Returns a unified diff with line counts. ' +
      'Pass either file_a + file_b, or file_path + content.',
    parameters: {
      type: 'object',
      properties: {
        file_a: { type: 'string', description: 'First file to compare.' },
        file_b: { type: 'string', description: 'Second file to compare.' },
        file_path: { type: 'string', description: 'File to compare against literal content.' },
        content: { type: 'string', description: 'Literal text to compare file_path against.' },
      },
      required: [],
    },
  },
};

// ─── Local helpers ───

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('=')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// ─── Handler ───

export async function diffFiles(args: unknown, _sessionId?: string): Promise<string> {
  return safe(async () => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('diff arguments must be an object with file_a/file_b or file_path/content.');
    }
    const input = args as Record<string, unknown>;
    const fileA = optionalString(input.file_a);
    const fileB = optionalString(input.file_b);
    const filePath = optionalString(input.file_path);
    const hasContent = Object.prototype.hasOwnProperty.call(input, 'content') && typeof input.content === 'string';

    let labelA: string;
    let labelB: string;
    let contentA: string;
    let contentB: string;

    if (fileA && fileB) {
      const validA = await validatePath(fileA);
      const validB = await validatePath(fileB);
      contentA = (await readRegularFile(validA, fileA, MAX_DIFF_FILE_BYTES)).content;
      contentB = (await readRegularFile(validB, fileB, MAX_DIFF_FILE_BYTES)).content;
      labelA = fileA;
      labelB = fileB;
    } else if (filePath && hasContent) {
      const validated = await validatePath(filePath);
      contentA = (await readRegularFile(validated, filePath, MAX_DIFF_FILE_BYTES)).content;
      contentB = input.content as string;
      labelA = filePath;
      labelB = '(provided content)';
    } else {
      throw new Error('Provide either file_a and file_b, or file_path and content.');
    }

    if (contentA === contentB) {
      return `No differences: ${labelA} and ${labelB} are identical (${countLines(contentA)} lines).`;
    }
    const diff = computeUnifiedDiff(contentA, contentB, `${labelA} vs ${labelB}`);
    const { added, removed } = countDiffChanges(diff);
    return `Comparing ${labelA} to ${labelB} (${countLines(contentA)} vs ${countLines(contentB)} lines; +${added}/-${removed}):\n${diff}`;
  });
}

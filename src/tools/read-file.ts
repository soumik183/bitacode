/**
 * read_file tool — Read file contents with optional offset/limit or line ranges.
 *
 * When a file is not found, suggests similar paths to help the model
 * recover from typos without repeated failed attempts.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { validatePath } from '../utils/path-validation.js';
import { findSimilarPaths } from '../utils/path-suggestions.js';
import { recordRead } from '../utils/file-time.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const BINARY_SNIFF_BYTES = 8192;
const MAX_RANGES = 20;

interface LineRange {
  start: number;
  end: number;
}

interface RangeSection extends LineRange {
  lines: string[];
}

/** Suggest close matches so the model can recover from a typo without retrying blindly. */
async function notFoundMessage(filePath: string): Promise<string> {
  const suggestions = await findSimilarPaths(filePath);
  let msg = `File not found: '${filePath}'`;
  if (suggestions.length > 0) {
    msg += '\nDid you mean one of these?\n' + suggestions.map(s => `  ${s}`).join('\n');
  }
  return msg;
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '... (line truncated)' : line;
}

/** Parse 1-based ranges like "2-50, 90-300"; overlaps are merged. */
function parseLineRanges(input: string): LineRange[] {
  const tokens = input.split(/[,;]/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('ranges cannot be empty. Use "2-50,90-300".');
  }
  if (tokens.length > MAX_RANGES) {
    throw new Error(`too many ranges (${tokens.length}); maximum is ${MAX_RANGES}.`);
  }

  const ranges = tokens.map((token) => {
    const match = /^(\d+)\s*(?:-|:|\.\.|to)\s*(\d+)$/i.exec(token) ?? /^(\d+)$/.exec(token);
    if (!match) {
      throw new Error(`invalid range "${token}". Use "start-end" with 1-based line numbers.`);
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error(`invalid range "${token}". Line numbers must be integers.`);
    }
    if (start < 1) {
      throw new Error(`invalid range "${token}". Line numbers start at 1.`);
    }
    if (end < start) {
      throw new Error(`invalid range "${token}". The end line must be after the start line.`);
    }
    return { start, end };
  });

  ranges.sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const requestedLines = merged.reduce((total, range) => total + range.end - range.start + 1, 0);
  if (requestedLines > DEFAULT_LIMIT) {
    throw new Error(
      `requested ${requestedLines} lines; maximum is ${DEFAULT_LIMIT} per read. Use narrower ranges.`
    );
  }
  return merged;
}

function formatRangeSections(sections: RangeSection[], totalLines: number): string {
  return sections
    .map((section) => {
      let body: string;
      if (totalLines === 0) {
        body = '(empty file)';
      } else if (section.lines.length === 0) {
        body = `(no lines: file has ${totalLines} line(s))`;
      } else {
        body = section.lines.join('\n');
        if (section.end > totalLines) {
          body += `\n... (file ends at line ${totalLines})`;
        }
      }
      return `[lines ${section.start}-${section.end}]\n${body}`;
    })
    .join('\n');
}

export const readFileTool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description:
      'Read the contents of a file. Use offset and limit for one section, or ranges to read several ' +
      'specific line ranges (1-based), for example "2-50,90-300".',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read (relative to working directory).' },
        offset: { type: 'number', description: 'Line number to start reading from (0-based). Defaults to 0.' },
        limit: { type: 'number', description: 'Maximum number of lines to read. Defaults to 2000.' },
        ranges: {
          type: 'string',
          description:
            'Comma-separated 1-based line ranges, e.g. "2-50,90-300". Use instead of offset/limit. Overlaps are merged; maximum 2000 lines total.',
        },
      },
      required: ['file_path'],
    },
  },
};

export async function readFile(
  filePath: string,
  offset = 0,
  limit = DEFAULT_LIMIT,
  sessionId?: string,
  ranges?: string
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'Error: file_path is required.';
  }

  let requestedRanges: LineRange[] | null = null;
  if (ranges !== undefined) {
    if (typeof ranges !== 'string') {
      return 'Error: ranges must be a string like "2-50,90-300".';
    }
    try {
      requestedRanges = parseLineRanges(ranges);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  const start = offset == null ? 0 : Math.floor(Number(offset));
  const maxLines = limit == null ? DEFAULT_LIMIT : Math.floor(Number(limit));
  if (!requestedRanges && (!Number.isFinite(start) || start < 0)) {
    return 'Error: offset must be a non-negative integer.';
  }
  if (!requestedRanges && (!Number.isFinite(maxLines) || maxLines < 1)) {
    return 'Error: limit must be a positive integer.';
  }

  let validated: string;
  try {
    validated = await validatePath(filePath);
  } catch (err: any) {
    if (err.message?.includes('does not exist')) {
      return notFoundMessage(filePath);
    }
    return `Error: ${err.message}`;
  }

  let stats;
  try {
    stats = await fs.stat(validated);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return notFoundMessage(filePath);
    }
    return `Error: cannot read '${filePath}': ${err.message}`;
  }

  if (stats.isDirectory()) {
    return `Error: '${filePath}' is a directory. Use list_directory to inspect its contents.`;
  }
  if (!stats.isFile()) {
    return `Error: '${filePath}' is not a regular file.`;
  }

  // Refuse binary files instead of streaming mojibake into the model context.
  try {
    const handle = await fs.open(validated, 'r');
    try {
      const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stats.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (buf.subarray(0, bytesRead).includes(0)) {
        return `Error: '${filePath}' appears to be a binary file (contains null bytes).`;
      }
    } finally {
      await handle.close();
    }
  } catch (err: any) {
    return `Error: cannot read '${filePath}': ${err.message}`;
  }

  const lines: string[] = [];
  const rangeSections: RangeSection[] | null = requestedRanges
    ? requestedRanges.map((range) => ({ ...range, lines: [] }))
    : null;
  let totalLines = 0;

  const stream = createReadStream(validated, { encoding: 'utf8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      if (rangeSections) {
        const lineNumber = totalLines + 1;
        for (const section of rangeSections) {
          if (lineNumber >= section.start && lineNumber <= section.end) {
            section.lines.push(truncateLine(line));
          }
        }
      } else if (totalLines >= start && lines.length < maxLines) {
        lines.push(line);
      }
      totalLines++;
    }
  } catch (err: any) {
    return `Error: cannot read '${filePath}': ${err.message}`;
  } finally {
    lineReader.close();
    stream.destroy();
  }

  // Record successful read for staleness tracking
  if (sessionId) {
    recordRead(sessionId, validated);
  }

  if (rangeSections) {
    return formatRangeSections(rangeSections, totalLines);
  }

  if (lines.length === 0) {
    if (totalLines === 0) return '';
    return `(no lines read: offset ${start} is past the end of the file, which has ${totalLines} line(s))`;
  }

  // Truncate very long individual lines but don't reformat content
  const slice = lines.map(truncateLine);

  let result = slice.join('\n');
  if (start + lines.length < totalLines) {
    result += `\n... (${totalLines - start - lines.length} more line(s); use offset=${start + lines.length} to continue)`;
  }
  return result;
}
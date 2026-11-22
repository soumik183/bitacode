/**
 * read_lines tool — Read ONE specific 1-based line range from a file.
 *
 * One call = one range (e.g. 70-90 or 199-300). To read more lines, call the
 * tool again with another range. The result uses the same `[lines a-b]` format
 * as read_file so the transcript UI can show a compact `path · 70-90` summary.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { validatePath } from '../utils/path-validation.js';
import { findSimilarPaths } from '../utils/path-suggestions.js';
import { recordRead } from '../utils/file-time.js';

const DEFAULT_MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const BINARY_SNIFF_BYTES = 8192;

interface LineRange {
  start: number;
  end: number;
}

/** Suggest close matches so the model can recover from a typo without retrying blindly. */
async function notFoundMessage(filePath: string): Promise<string> {
  const suggestions = await findSimilarPaths(filePath);
  let msg = `File not found: '${filePath}'`;
  if (suggestions.length > 0) {
    msg += '\nDid you mean one of these?\n' + suggestions.map((s) => `  ${s}`).join('\n');
  }
  return msg;
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '... (line truncated)' : line;
}

/**
 * Parse a single range. Accepts `from`/`to` numbers or one string like "70-90".
 * Multiple ranges are rejected with a clear instruction to call again.
 */
function parseRange(options: {
  from?: number;
  to?: number;
  ranges?: string;
  maxLines: number;
}): LineRange | string {
  if (options.ranges !== undefined) {
    if (typeof options.ranges !== 'string') {
      return 'Error: ranges must be a string like "70-90".';
    }
    const value = options.ranges.trim();
    const parts = value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      return 'Error: read_lines reads one range at a time. Call again for the next range (e.g. 300-500).';
    }
    const match = /^(\d+)\s*(?:-|:|\.\.|to)\s*(\d+)$/i.exec(value) ?? /^(\d+)$/.exec(value);
    if (!match || !/^\d+\s*(?:-|:|\.\.|to)\s*\d+$/i.test(value)) {
      return 'Error: invalid range. Use "start-end" with 1-based line numbers, e.g. "70-90".';
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    return validateRange(start, end, options.maxLines);
  }

  const from = Number(options.from);
  const to = Number(options.to);
  if (!Number.isSafeInteger(from) || from < 1) {
    return 'Error: from must be a positive integer (1-based start line).';
  }
  if (!Number.isSafeInteger(to) || to < 1) {
    return 'Error: to must be a positive integer (1-based end line).';
  }
  return validateRange(from, to, options.maxLines);
}

function validateRange(start: number, end: number, maxLines: number): LineRange | string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return 'Error: line numbers must be integers.';
  }
  if (start < 1) {
    return 'Error: line numbers start at 1.';
  }
  if (end < start) {
    return 'Error: the end line must be greater than or equal to the start line.';
  }
  const count = end - start + 1;
  if (count > maxLines) {
    return `Error: requested ${count} lines; maximum is ${maxLines} per read. Use a narrower range.`;
  }
  return { start, end };
}

export const readLinesTool = {
  type: 'function' as const,
  function: {
    name: 'read_lines',
    description:
      'Read ONE specific 1-based line range from a file, e.g. from=70, to=90. ' +
      'Only one range per call: to read more lines, call again (e.g. 300-500). ' +
      'Returns the lines with a [lines a-b] header for display.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read (relative to working directory).' },
        from: { type: 'number', description: 'First line to read (1-based, inclusive).' },
        to: { type: 'number', description: 'Last line to read (1-based, inclusive).' },
        max_lines: { type: 'number', description: 'Optional total line cap, default 2000.' },
      },
      required: ['file_path', 'from', 'to'],
    },
  },
};

export interface ReadLinesOptions {
  from?: number;
  to?: number;
  /** Deprecated single-range string form: "70-90". Multiple ranges are rejected. */
  ranges?: string;
  maxLines?: number;
  sessionId?: string;
}

function formatSection(range: LineRange, lines: string[], totalLines: number): string {
  let body: string;
  if (totalLines === 0) {
    body = '(empty file)';
  } else if (lines.length === 0) {
    body = `(no lines: file has ${totalLines} line(s))`;
  } else {
    body = lines.join('\n');
    if (range.end > totalLines) {
      body += `\n... (file ends at line ${totalLines})`;
    }
  }
  return `[lines ${range.start}-${range.end}]\n${body}`;
}

export async function readLines(filePath: string, options: ReadLinesOptions = {}): Promise<string> {
  try {
    return await readLinesImpl(filePath, options);
  } catch (err: any) {
    // The dispatcher expects a string result even for unexpected failures.
    return `Error: ${err?.message ?? String(err)}`;
  }
}

async function readLinesImpl(filePath: string, options: ReadLinesOptions): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'Error: file_path is required.';
  }

  const cap = options.maxLines === undefined ? DEFAULT_MAX_LINES : Number(options.maxLines);
  if (!Number.isSafeInteger(cap) || cap < 1) {
    return 'Error: max_lines must be a positive integer.';
  }

  const range = parseRange({ from: options.from, to: options.to, ranges: options.ranges, maxLines: cap });
  if (typeof range === 'string') return range;

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
  let totalLines = 0;
  const stream = createReadStream(validated, { encoding: 'utf8' });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lineReader) {
      totalLines++;
      if (totalLines >= range.start && totalLines <= range.end) {
        lines.push(truncateLine(line));
      }
    }
  } catch (err: any) {
    return `Error: cannot read '${filePath}': ${err.message}`;
  } finally {
    lineReader.close();
    stream.destroy();
  }

  if (options.sessionId) {
    recordRead(options.sessionId, validated);
  }
  return formatSection(range, lines, totalLines);
}

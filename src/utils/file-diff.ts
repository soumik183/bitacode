/** Pure helpers that turn file tool results into UI-friendly data. */

import { isAbsolute, relative, resolve } from 'node:path';

/** One file's diff inside a multi-file tool result. */
export interface FileDiffEntry {
  filePath?: string;
  header: string;
  diff: string;
}

export interface FileMutationDiff {
  header: string;
  diff: string;
  filePath?: string; // kept for single-file compatibility
  entries: FileDiffEntry[]; // one per file, always present
  operation: 'Edited' | 'Wrote';
}

export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  number?: number;
  text: string;
}

export interface FileReadSection {
  startLine: number;
  endLine: number;
  lines: string[];
  note?: string;
}

export interface FileReadDisplay {
  filePath?: string;
  sections: FileReadSection[];
  totalLines?: number;
}

/** Compact, one-line description of a file read result for the transcript. */
export interface ReadSummary {
  filePath: string;
  range?: string;
  total?: number;
  empty?: boolean;
}

const FILE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'multiedit',
  'multi_edit',
  'apply_patch',
]);

const READ_TOOLS = new Set(['read_file', 'read_lines']);

const MULTI_SECTION_RE = /^--- (.+?) \((\d+) replacement\(s\)\)$/;
const PATCH_SECTION_RE = /^--- (.+?) \(\+(\d+)\/-(\d+)\)(?: \(deleted\))?$/;

function isSuccessfulMutation(result: string): boolean {
  return /^Successfully (edited|wrote)\b/i.test(result.trim()) || /^Applied patch\b/i.test(result.trim());
}

/** File metadata that makes a terminal diff noisier than it needs to be. */
function isMetadataLine(line: string): boolean {
  return (
    line.startsWith('Index: ') ||
    line.startsWith('diff --git ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('\\ No newline') ||
    /^=+$/.test(line)
  );
}

function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function argFilePath(args: string | Record<string, unknown> | undefined): string | undefined {
  const filePath = parseArgs(args).file_path;
  return typeof filePath === 'string' && filePath.trim() ? filePath : undefined;
}

/** Prefer the `+++ b/path` header, falling back to `--- a/path` for deletes. */
function pathFromDiff(diff: string): string | undefined {
  for (const line of diff.split('\n')) {
    const header = /^(?:--- |\+\+\+ )(.+)$/.exec(line);
    if (!header) continue;
    const name = (header[1] ?? '').split('\t')[0]!.trim();
    if (!name || name === '/dev/null') continue;
    return name.replace(/^[ab]\//, '');
  }
  return undefined;
}

function buildDiff(
  header: string,
  entries: FileDiffEntry[],
  operation: 'Edited' | 'Wrote'
): FileMutationDiff {
  return {
    header,
    filePath: entries[0]?.filePath,
    diff: entries.map((entry) => entry.diff).join('\n'),
    entries,
    operation,
  };
}

/** Split a `Successfully edited N file(s)` / `Applied patch` result per file. */
function parseSectionedResult(
  text: string,
  sectionRe: RegExp,
  operation: 'Edited' | 'Wrote'
): FileMutationDiff | null {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (sectionRe.test(line)) starts.push(index);
  });
  if (starts.length === 0) return null;

  const entries = starts.map((start, index): FileDiffEntry => {
    const end = index + 1 < starts.length ? starts[index + 1]! : lines.length;
    const block = lines.slice(start, end);
    const match = sectionRe.exec(block[0] ?? '');
    const diffLines = block.slice(1);
    while (diffLines.length > 0 && diffLines[diffLines.length - 1] === '') diffLines.pop();
    return {
      header: block[0] ?? '',
      filePath: match?.[1]?.trim() || pathFromDiff(diffLines.join('\n')),
      diff: diffLines.join('\n'),
    };
  });

  return buildDiff(lines[0] ?? text, entries, operation);
}

/** Path relative to the project folder, so file boxes stay short. */
export function displayFilePath(filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
  const rel = relative(process.cwd(), absolute).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : filePath;
}

/**
 * Returns the header, unified diff and relative file path for a successful
 * file mutation. Errors, cancellations and unrelated tools return null so
 * callers can fall back to their normal one-line result rendering.
 */
export function parseFileMutationDiff(
  toolName: string,
  args: string | Record<string, unknown> | undefined,
  result: string
): FileMutationDiff | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  const text = result.trim();
  if (!isSuccessfulMutation(text)) return null;

  const operation: 'Edited' | 'Wrote' = toolName === 'write_file' ? 'Wrote' : 'Edited';

  if (toolName === 'multiedit' || toolName === 'multi_edit' || toolName === 'apply_patch') {
    const parsed = parseSectionedResult(
      text,
      toolName === 'apply_patch' ? PATCH_SECTION_RE : MULTI_SECTION_RE,
      operation
    );
    // A legacy apply_patch result has only a +A/-R summary and no diff body;
    // let it render as plain text rather than fabricating a diff.
    if (parsed && toolName === 'apply_patch' && !parsed.entries.some((entry) => /^@@/m.test(entry.diff))) {
      return null;
    }
    return parsed;
  }

  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) => line.startsWith('Index: ') || line.startsWith('--- ') || line.startsWith('@@')
  );

  let header = text;
  let diff = '';
  if (start !== -1) {
    header = lines
      .slice(0, start)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^=+$/.test(line))
      .join(' ') || text;
    diff = lines.slice(start).join('\n');
  } else if (toolName === 'write_file') {
    // Older write_file results had no diff: show the write as pure additions.
    const { content } = parseArgs(args);
    if (typeof content === 'string') {
      const contentLines = content.replace(/\r\n/g, '\n').split('\n');
      if (contentLines[contentLines.length - 1] === '') contentLines.pop();
      diff = contentLines.map((line) => `+${line}`).join('\n');
    }
  }

  const filePath = argFilePath(args) ?? pathFromDiff(diff);
  return buildDiff(header, [{ header, filePath, diff }], operation);
}

/** Adds old/new file line numbers to unified diff lines. */
export function annotateDiff(diff: string): DiffLine[] {
  const raw = diff ? diff.split('\n') : [];
  const lines = raw.filter((line, index) => !(index === raw.length - 1 && line === ''));
  let oldLine = 0;
  let newLine = 0;
  let fallbackLine = 1;
  let sawHunk = false;

  return lines.map((line) => {
    // File headers and separators are metadata, never add/remove content.
    if (isMetadataLine(line)) return { kind: 'meta' as const, text: line };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      sawHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk', text: line };
    }
    if (line.startsWith('+')) {
      const number = sawHunk ? newLine++ : fallbackLine++;
      return { kind: 'add', number, text: line.slice(1) };
    }
    if (line.startsWith('-')) {
      const number = sawHunk ? oldLine++ : fallbackLine++;
      return { kind: 'remove', number, text: line.slice(1) };
    }
    if (line.startsWith(' ')) {
      const number = sawHunk ? newLine : fallbackLine++;
      if (sawHunk) {
        oldLine++;
        newLine++;
      }
      return { kind: 'context', number, text: line.slice(1) };
    }
    return { kind: 'meta', text: line };
  });
}

/**
 * Turns a read_file / read_lines result into a compact preview. Handles both
 * a single offset/limit read and range sections like "[lines 2-50]". Large
 * reads are capped by the caller so one file cannot flood the scrollback.
 */
export function parseFileReadResult(
  toolName: string,
  args: string | Record<string, unknown> | undefined,
  result: string
): FileReadDisplay | null {
  if (!READ_TOOLS.has(toolName) || /^(Error\b|File not found\b|Operation cancelled\b|\(no lines read\b)/i.test(result.trim())) {
    return null;
  }

  const parsedArgs = parseArgs(args);
  const offset = typeof parsedArgs.offset === 'number' && parsedArgs.offset > 0 ? Math.floor(parsedArgs.offset) : 0;
  const raw = result.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();

  const sections: FileReadSection[] = [];
  let current: FileReadSection | null = null;
  for (const line of raw) {
    const header = /^\[lines (\d+)-(\d+)\]$/.exec(line);
    if (header) {
      current = {
        startLine: Number(header[1]),
        endLine: Number(header[2]),
        lines: [],
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\.\.\. \(file ends at line \d+\)$/.test(line) || /^\((empty file|no lines: file has \d+ line\(s\))\)$/.test(line)) {
      current.note = line;
      continue;
    }
    current.lines.push(line);
  }

  if (sections.length > 0) {
    let totalLines: number | undefined;
    for (const section of sections) {
      const note = section.note ?? '';
      const ends = /file ends at line (\d+)/.exec(note);
      const noLines = /no lines: file has (\d+) line\(s\)/.exec(note);
      if (ends) totalLines = Number(ends[1]);
      else if (noLines) totalLines = Number(noLines[1]);
      else if (note === '(empty file)') totalLines = 0;
    }
    return { filePath: argFilePath(args), sections, totalLines };
  }

  const lines = [...raw];
  const moreMatch = /^\.\.\. \((\d+) more line\(s\); use offset=\d+ to continue\)$/.exec(lines[lines.length - 1] ?? '');
  const moreLines = moreMatch ? Number(moreMatch[1]) : 0;
  if (moreMatch) lines.pop();
  if (lines.length === 1 && lines[0] === '') lines.pop();

  return {
    filePath: argFilePath(args),
    totalLines: offset + lines.length + moreLines,
    sections: [
      {
        startLine: offset + 1,
        endLine: offset + lines.length,
        lines,
        note: moreLines > 0 ? `… ${moreLines} more line${moreLines === 1 ? '' : 's'}` : undefined,
      },
    ],
  };
}

/** Describes a parsed read as one of: whole file, line range, or empty. */
export function describeRead(display: FileReadDisplay): ReadSummary {
  const filePath = display?.filePath ? displayFilePath(display.filePath) : 'file';
  const sections = Array.isArray(display?.sections) ? display.sections : [];
  const readLines = sections.reduce((total, section) => total + (Array.isArray(section?.lines) ? section.lines.length : 0), 0);
  if (readLines === 0) return { filePath, empty: true };

  const total = display?.totalLines;
  if (typeof total === 'number' && total > 0) {
    const covered = sections
      .filter((section) => section && Array.isArray(section.lines) && section.lines.length > 0 && typeof section.startLine === 'number')
      .map((section) => ({ start: section.startLine, end: section.startLine + section.lines.length - 1 }))
      .sort((a, b) => a.start - b.start);
    let cursor = 1;
    let whole = covered.length > 0;
    for (const segment of covered) {
      if (segment.start > cursor) {
        whole = false;
        break;
      }
      cursor = Math.max(cursor, segment.end + 1);
    }
    if (whole && cursor - 1 >= total) return { filePath, total };
  }

  const range = sections
    .filter((section) => section && typeof section.startLine === 'number')
    .map((section) => {
      // The header holds the requested range: keep it even when the tool
      // clamped the read to the end of the file.
      if (typeof section.endLine === 'number' && section.endLine >= section.startLine) {
        return `${section.startLine}-${section.endLine}`;
      }
      const count = Array.isArray(section.lines) ? section.lines.length : 0;
      if (count > 0) return `${section.startLine}-${section.startLine + count - 1}`;
      return `${section.startLine}`;
    })
    .join(', ');

  return range ? { filePath, range } : { filePath, empty: true };
}

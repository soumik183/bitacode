import React from 'react';
import { Text } from 'ink';
import { getTheme } from '../theme.js';
import type { Theme } from '../theme.js';
import { safeHighlight, type HighlightToken } from '../utils/code-highlight.js';

/**
 * Normalize text for transcript display.
 * - Collapses multiple consecutive newlines into a single newline
 * - Trims leading/trailing whitespace
 * - Returns empty string if text is empty/whitespace only
 */
export function normalizeTranscriptText(text: string): string {
  if (!text || !text.trim()) {
    return '';
  }
  // Collapse multiple newlines to single, trim ends
  return text.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Rich Markdown-ish renderer for chat text. Returns only <Text> nodes so the
 * result can be nested inside a parent <Text> (all callers do this, including
 * the live streaming preview).
 *
 * Frame-safety: a normal input line maps to exactly one output row. Fenced
 * code and pipe tables are the only multi-row constructs and both have hard
 * row budgets; a global row cap guards against many of them in one message.
 * The renderer is called every animation frame on partially streamed text, so
 * it stays cheap, deterministic and never throws (plain-text fallback).
 */

// ── Work budgets ──
const MAX_RENDER_CHARS = 50_000;
const MAX_CODE_ROWS = 12;
const MAX_INLINE_CODE_CHARS = 500;
const MAX_OUTPUT_ROWS = 200;
const MAX_LIST_DEPTH = 6;
const MAX_TABLE_BODY_ROWS = 40;
const MAX_TABLE_COLS = 8;
const MAX_TABLE_CELL_CHARS = 120;
const MAX_TABLE_OUTPUT_ROWS = 20;

/**
 * Two legacy syntax colours are intentionally theme-independent (they are not
 * part of the 15-key Theme type): yellow for list markers/tasks and orange for
 * warnings. Everything else is derived from the active palette below.
 */
const MARKER = '#facc15';
const WARNING = '#fb923c';

/** Colours and styles derived once per render from the caller's palette. */
interface RenderCtx {
  palette: Theme;
  marker: string;
  /** h1 → h3 use accent/info/success, h4+ recede to muted. */
  heading: string[];
  callout: Record<string, string>;
}

function ctxFor(palette: Theme): RenderCtx {
  return {
    palette,
    marker: MARKER,
    heading: [palette.accent, palette.info, palette.success, palette.muted, palette.muted, palette.muted],
    callout: {
      ERROR: palette.error,
      WARNING,
      WARN: WARNING,
      TIP: palette.success,
      NOTE: palette.info,
      TODO: MARKER,
      FIXME: palette.error,
    },
  };
}

// Inline alternatives are ordered most-specific first so *** wins over ** over *.
const INLINE_PATTERN =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(https?:\/\/[^\s)]+)|(\*\*\*[^*\n]+?\*\*\*)|(\*\*[^*\n]+?\*\*)|(~~[^~\n]+?~~)|(\*[^\s*][^*]*?\*)/g;

const FENCE_OPEN = /^\s*(?:```|~~~)\s*([\w.+-]*)\s*$/;
const FENCE_CLOSE = /^\s*(?:```|~~~)\s*$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^(\s*)((?:>\s?)+)(.*)$/;
const TASK = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const UNORDERED = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+\.)\s+(.*)$/;
const CALLOUT = /^\s*(ERROR|WARNING|WARN|TIP|NOTE|TODO|FIXME)\s*:\s*(.*)$/i;

/**
 * Bounded memo so repeated frames do not re-tokenize identical code. Cached
 * tokens carry palette colours, so the memo is keyed by palette object rather
 * than shared across themes (a theme switch repaints correctly).
 */
const HIGHLIGHT_CACHE = new WeakMap<Theme, Map<string, HighlightToken[][]>>();
const HIGHLIGHT_CACHE_MAX = 256;
const HIGHLIGHT_CACHE_ITEM_MAX = 2000;

function cachedHighlight(code: string, language: string, maxChars: number, palette: Theme): HighlightToken[][] {
  if (code.length > HIGHLIGHT_CACHE_ITEM_MAX) {
    return safeHighlight(code, language, { maxChars, palette });
  }
  let byCode = HIGHLIGHT_CACHE.get(palette);
  if (!byCode) {
    byCode = new Map();
    HIGHLIGHT_CACHE.set(palette, byCode);
  }
  const key = `${language}\u0000${maxChars}\u0000${code}`;
  const hit = byCode.get(key);
  if (hit) return hit;
  const tokens = safeHighlight(code, language, { maxChars, palette });
  if (byCode.size >= HIGHLIGHT_CACHE_MAX) {
    const oldest = byCode.keys().next().value;
    if (oldest !== undefined) byCode.delete(oldest);
  }
  byCode.set(key, tokens);
  return tokens;
}

function renderTokens(tokens: HighlightToken[], keyPrefix: string, baseColor?: string): React.ReactNode[] {
  return tokens.map((token, index) => (
    <Text key={`${keyPrefix}-${index}`} color={token.color ?? baseColor} bold={token.bold} dimColor={token.dim}>
      {token.text}
    </Text>
  ));
}

function renderInlineCode(code: string, key: string, ctx: RenderCtx): React.ReactNode {
  const [tokens = []] = cachedHighlight(code, 'text', MAX_INLINE_CODE_CHARS, ctx.palette);
  return (
    <Text key={key} backgroundColor={ctx.palette.surfaceAlt} color={ctx.palette.success}>
      {renderTokens(tokens, key, ctx.palette.success)}
    </Text>
  );
}

function renderLink(raw: string, key: string, ctx: RenderCtx): React.ReactNode {
  const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
  if (!match) {
    return <Text key={key}>{raw}</Text>;
  }
  return (
    <Text key={key}>
      <Text color={ctx.palette.accent} underline>{match[1]}</Text>
      <Text color={ctx.palette.dim}>{` (${match[2]})`}</Text>
    </Text>
  );
}

function renderInline(text: string, keyPrefix: string, ctx: RenderCtx): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match[0].length === 0) {
      INLINE_PATTERN.lastIndex++;
      continue;
    }
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const key = `${keyPrefix}-i${match.index}`;
    if (match[1] !== undefined) {
      nodes.push(renderInlineCode(match[1].slice(1, -1), key, ctx));
    } else if (match[2] !== undefined) {
      nodes.push(renderLink(match[2], key, ctx));
    } else if (match[3] !== undefined) {
      nodes.push(<Text key={key} color={ctx.palette.info}>{match[3]}</Text>);
    } else if (match[4] !== undefined) {
      nodes.push(<Text key={key} bold italic>{match[4].slice(3, -3)}</Text>);
    } else if (match[5] !== undefined) {
      nodes.push(<Text key={key} bold>{match[5].slice(2, -2)}</Text>);
    } else if (match[6] !== undefined) {
      nodes.push(<Text key={key} strikethrough dimColor>{match[6].slice(2, -2)}</Text>);
    } else if (match[7] !== undefined) {
      nodes.push(<Text key={key} italic>{match[7].slice(1, -1)}</Text>);
    }
    last = INLINE_PATTERN.lastIndex;
  }

  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/** Capped indentation: deeper nesting is wider, but can never push text off-screen. */
function indentFor(ws: string): string {
  const width = ws.replace(/\t/g, '  ').length;
  return ' '.repeat(Math.min(width, MAX_LIST_DEPTH * 2));
}

function renderLine(line: string, key: string, ctx: RenderCtx): React.ReactNode {
  const heading = HEADING.exec(line);
  if (heading) {
    return (
      <Text key={key} bold color={ctx.heading[heading[1].length - 1]}>
        {renderInline(heading[2], key, ctx)}
      </Text>
    );
  }

  const quote = QUOTE.exec(line);
  if (quote) {
    const bars = (quote[2].match(/>/g) ?? []).length;
    return (
      <Text key={key}>
        {Array.from({ length: bars }, (_, i) => (
          <Text key={`${key}-b${i}`} color={ctx.palette.accent}>│ </Text>
        ))}
        <Text color={ctx.palette.muted} italic>{renderInline(quote[3], key, ctx)}</Text>
      </Text>
    );
  }

  const task = TASK.exec(line);
  if (task) {
    const done = task[3] === 'x' || task[3] === 'X';
    return (
      <Text key={key}>
        <Text color={ctx.palette.muted}>{indentFor(task[1])}</Text>
        <Text color={done ? ctx.palette.success : ctx.marker} bold>{done ? '☑ ' : '☐ '}</Text>
        <Text>{renderInline(task[4], key, ctx)}</Text>
      </Text>
    );
  }

  const unordered = UNORDERED.exec(line);
  if (unordered) {
    return (
      <Text key={key}>
        <Text color={ctx.palette.muted}>{indentFor(unordered[1])}</Text>
        <Text color={ctx.marker} bold>{'• '}</Text>
        <Text>{renderInline(unordered[3], key, ctx)}</Text>
      </Text>
    );
  }

  const ordered = ORDERED.exec(line);
  if (ordered) {
    return (
      <Text key={key}>
        <Text color={ctx.palette.muted}>{indentFor(ordered[1])}</Text>
        <Text color={ctx.marker} bold>{ordered[2] + ' '}</Text>
        <Text>{renderInline(ordered[3], key, ctx)}</Text>
      </Text>
    );
  }

  const callout = CALLOUT.exec(line);
  if (callout) {
    const color = ctx.callout[callout[1].toUpperCase()] ?? ctx.palette.info;
    return (
      <Text key={key}>
        <Text color={color} bold>{`${callout[1]}: `}</Text>
        <Text>{renderInline(callout[2], key, ctx)}</Text>
      </Text>
    );
  }

  return <Text key={key}>{renderInline(line, key, ctx)}</Text>;
}

/** A horizontal rule becomes one dim divider row. */
function renderHorizontalRule(line: string, key: string, ctx: RenderCtx): React.ReactNode {
  const width = Math.min(40, Math.max(3, line.trim().length));
  return <Text key={key} color={ctx.palette.dim}>{'─'.repeat(width)}</Text>;
}

/** Highlight a fenced block with a hard row budget so it cannot grow the frame. */
function renderFenced(codeLines: string[], language: string, keyPrefix: string, ctx: RenderCtx): React.ReactNode[] {
  const shown = codeLines.slice(0, MAX_CODE_ROWS);
  const hidden = codeLines.length - shown.length;
  const tokenRows = cachedHighlight(shown.join('\n'), language, MAX_RENDER_CHARS, ctx.palette);

  const nodes: React.ReactNode[] = tokenRows.map((tokens, index) => (
    <Text key={`${keyPrefix}-c${index}`}>
      <Text color={ctx.palette.dim}>  </Text>
      {renderTokens(tokens, `${keyPrefix}-c${index}`, ctx.palette.text)}
    </Text>
  ));

  if (hidden > 0) {
    nodes.push(
      <Text key={`${keyPrefix}-more`} color={ctx.palette.dim}>
        {`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
      </Text>
    );
  }
  return nodes;
}

// ── GFM pipe tables ──
type Align = 'left' | 'center' | 'right';

interface TableHead {
  header: string[];
  aligns: Align[];
  body: string[][];
  endIndex: number;
}

/** Split a markdown row on unescaped pipes that are not inside inline code. */
function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  if (!cells.length) return null;
  return cells.map((cell) => cell.trim());
}

/** Validate a `---` / `:---` / `---:` / `:---:` separator row. */
function parseSeparator(line: string): Align[] | null {
  const cells = splitTableRow(line);
  if (!cells) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    const compact = cell.replace(/\s/g, '');
    if (!/^:?-+:?$/.test(compact)) return null;
    const left = compact.startsWith(':');
    const right = compact.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return aligns;
}

function detectTable(lines: string[], start: number): TableHead | null {
  const header = splitTableRow(lines[start]);
  if (!header || start + 1 >= lines.length) return null; // no separator yet -> plain text
  const aligns = parseSeparator(lines[start + 1]);
  if (!aligns || aligns.length !== header.length) return null;

  const body: string[][] = [];
  let i = start + 2;
  while (i < lines.length && body.length < MAX_TABLE_BODY_ROWS) {
    const cells = splitTableRow(lines[i]);
    if (!cells) break;
    body.push(cells);
    i++;
  }
  return { header, aligns, body, endIndex: i };
}

/** Visible width of a cell, treating wide CJK/emoji as two terminal columns. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) ||
      (cp >= 0xfe20 && cp <= 0xfe2f)
    ) {
      continue; // combining marks take no column
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2329 && cp <= 0x232a) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Strip inline markers (and flatten <br>) for width measurement only. */
function cellDisplayText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '');
}

/** Trim a cell to a display-column budget so a table cannot outgrow the screen. */
function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    used += w;
    out += ch;
  }
  return out;
}

function renderTableCell(
  raw: string,
  width: number,
  align: Align,
  key: string,
  isHeader: boolean,
  ctx: RenderCtx
): React.ReactNode {
  // Inline markdown is rendered on the original cell; <br> degrades to a space.
  const content = raw.replace(/<br\s*\/?>/gi, ' ');
  // When a column budget is supplied, cut the cell text itself (not just its
  // padding) so the rendered row never exceeds the terminal width.
  const limited = displayWidth(cellDisplayText(content)) > width
    ? truncateToWidth(content, width)
    : content;
  const missing = Math.max(0, width - displayWidth(cellDisplayText(limited)));
  let padLeft = 0;
  let padRight = 0;
  if (align === 'right') {
    padLeft = missing;
  } else if (align === 'center') {
    padLeft = Math.floor(missing / 2);
    padRight = missing - padLeft;
  } else {
    padRight = missing;
  }
  const style = isHeader ? { bold: true, color: ctx.palette.accent } : {};
  return (
    <Text key={key} {...style}>
      {padLeft > 0 ? ' '.repeat(padLeft) : null}
      {renderInline(limited, key, ctx)}
      {padRight > 0 ? ' '.repeat(padRight) : null}
    </Text>
  );
}

function renderTableRow(
  row: string[],
  colCount: number,
  widths: number[],
  aligns: Align[],
  key: string,
  isHeader: boolean,
  ctx: RenderCtx
): React.ReactNode {
  const parts: React.ReactNode[] = [<Text key={`${key}-edge`} color={ctx.palette.dim}>{'│ '}</Text>];
  for (let ci = 0; ci < colCount; ci++) {
    if (ci > 0) {
      parts.push(<Text key={`${key}-sep${ci}`} color={ctx.palette.dim}>{' │ '}</Text>);
    }
    parts.push(renderTableCell(row[ci] ?? '', widths[ci], aligns[ci], `${key}-c${ci}`, isHeader, ctx));
  }
  parts.push(<Text key={`${key}-end`} color={ctx.palette.dim}>{' │'}</Text>);
  return <Text key={key}>{parts}</Text>;
}

function renderTableDivider(widths: number[], key: string, ctx: RenderCtx): React.ReactNode {
  const segments = widths.map((width) => '─'.repeat(Math.max(1, width + 2)));
  return <Text key={key} color={ctx.palette.dim}>{`├${segments.join('┼')}┤`}</Text>;
}

function renderTable(table: TableHead, keyPrefix: string, columns = 0, ctx: RenderCtx): React.ReactNode[] {
  const colCount = Math.min(
    MAX_TABLE_COLS,
    Math.max(1, table.header.length, ...table.body.map((row) => row.length))
  );
  const cellAt = (row: string[], ci: number): string => (row[ci] ?? '').slice(0, MAX_TABLE_CELL_CHARS);

  const widths: number[] = [];
  for (let ci = 0; ci < colCount; ci++) {
    let width = displayWidth(cellDisplayText(cellAt(table.header, ci)));
    for (const row of table.body) {
      width = Math.max(width, displayWidth(cellDisplayText(cellAt(row, ci))));
    }
    widths.push(Math.min(MAX_TABLE_CELL_CHARS, width));
  }

  // Scale the columns down to the available terminal width. `columns` is 0
  // when the caller does not constrain width, which preserves the old layout.
  if (columns > 0) {
    const overhead = colCount * 3 + 1; // '│ ' + ' │ ' per column + trailing '│'
    const budget = Math.max(colCount, columns - overhead);
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total > budget) {
      const scale = budget / total;
      for (let ci = 0; ci < colCount; ci++) {
        widths[ci] = Math.max(1, Math.floor(widths[ci] * scale));
      }
    }
  }

  const rows: React.ReactNode[] = [
    renderTableRow(table.header, colCount, widths, table.aligns, `${keyPrefix}-head`, true, ctx),
    renderTableDivider(widths, `${keyPrefix}-div`, ctx),
  ];

  const shown = Math.min(table.body.length, MAX_TABLE_OUTPUT_ROWS - 3);
  for (let i = 0; i < shown; i++) {
    rows.push(renderTableRow(table.body[i], colCount, widths, table.aligns, `${keyPrefix}-r${i}`, false, ctx));
  }
  const hidden = table.body.length - shown;
  if (hidden > 0) {
    rows.push(
      <Text key={`${keyPrefix}-more`} color={ctx.palette.dim}>{`  … ${hidden} more row${hidden === 1 ? '' : 's'}`}</Text>
    );
  }
  return rows;
}

/**
 * Render formatted text as Ink Text elements.
 * Returns an array of <Text> components that can be nested inside a parent <Text>.
 */
export function renderFormattedText(text: string, columns = 0, palette: Theme = getTheme()): React.ReactNode {
  const ctx = ctxFor(palette);
  try {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    if (!raw) {
      return '';
    }
    const capped = raw.length > MAX_RENDER_CHARS ? raw.slice(0, MAX_RENDER_CHARS) : raw;
    const lines = capped.split('\n');
    const rows: React.ReactNode[] = [];

    let index = 0;
    while (index < lines.length) {
      const line = lines[index];

      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        let end = index + 1;
        while (end < lines.length && !FENCE_CLOSE.test(lines[end])) {
          end++;
        }
        const language = fence[1] || 'text';
        rows.push(<Text key={`f${index}`} color={ctx.palette.dim}>{line}</Text>);
        rows.push(...renderFenced(lines.slice(index + 1, end), language, `f${index}`, ctx));
        if (end < lines.length) {
          rows.push(<Text key={`fc${end}`} color={ctx.palette.dim}>{lines[end]}</Text>);
        }
        index = end + 1;
        continue;
      }

      if (HR.test(line)) {
        rows.push(renderHorizontalRule(line, `hr${index}`, ctx));
        index++;
        continue;
      }

      // Table detection is defensive: any parse failure degrades to plain text.
      let table: TableHead | null = null;
      try {
        table = detectTable(lines, index);
      } catch {
        table = null;
      }
      if (table) {
        rows.push(...renderTable(table, `t${index}`, columns, ctx));
        index = table.endIndex;
        continue;
      }

      rows.push(renderLine(line, `l${index}`, ctx));
      index++;
    }

    // Global safety net: many bounded constructs in one message still cannot
    // grow the frame past a fixed number of rows.
    if (rows.length > MAX_OUTPUT_ROWS) {
      rows.length = MAX_OUTPUT_ROWS;
      rows.push(<Text key="rowcap" color={ctx.palette.dim}>{`  … ${rows.length} more rows`}</Text>);
    }

    // Re-join rows with the same newline structure as the input.
    const output: React.ReactNode[] = [];
    rows.forEach((row, i) => {
      output.push(row);
      if (i < rows.length - 1) {
        output.push('\n');
      }
    });
    return output;
  } catch {
    // Streaming text is often mid-marker; never let a parse edge case crash a frame.
    return <Text>{typeof text === 'string' ? text : String(text ?? '')}</Text>;
  }
}

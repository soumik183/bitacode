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
  // Keep paragraph breaks: markdown meaning depends on them (a table needs the
  // header row, its separator and the body as consecutive lines; a fenced block
  // keeps its blank lines). Collapsing to a single newline used to flatten every
  // paragraph and break tables, so only runs of three or more collapse to one.
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One predicate for both the streaming splitter and the renderer: any line
 * starting with a matching fence marker closes the block, with or without a
 * trailing language tag (` ``` ` and ` ```js ` both count). */
function fenceMarker(line: string): '```' | '~~~' | null {
  const trimmed = String(line ?? '').trim();
  if (trimmed.startsWith('```')) return '```';
  if (trimmed.startsWith('~~~')) return '~~~';
  return null;
}

/**
 * Split streamed markdown into completed blocks plus the still-growing tail.
 *
 * A markdown block is a run of lines separated by a blank line — and blank
 * lines inside a fenced code block do not end it. Flushing whole blocks instead
 * of single lines is what keeps tables, lists and fences intact while text
 * streams in: the old line-by-line flush handed `renderFormattedText` one line
 * at a time, so a table never saw its separator row and a fence was never
 * closed.
 */
export function splitMarkdownBlocks(text: string): { complete: string; tail: string } {
  const source = text ?? '';
  if (!source) return { complete: '', tail: '' };
  const lines = source.split('\n');
  let fence: '```' | '~~~' | null = null;
  let blankRunStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fence tracking: an opened fence swallows blank lines until it closes.
    const marker = fenceMarker(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      blankRunStart = -1;
      continue;
    }
    if (trimmed === '') {
      if (!fence && blankRunStart < 0) blankRunStart = i;
      continue;
    }
    if (blankRunStart >= 0 && !fence) {
      // Text resumed after a blank line: everything above it is one block.
      const complete = lines.slice(0, i).join('\n');
      const tail = lines.slice(i).join('\n');
      return { complete, tail };
    }
    blankRunStart = -1;
  }

  return { complete: '', tail: source };
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

/** Colours and styles derived once per render from the caller's palette. */
interface RenderCtx {
  palette: Theme;
  marker: string;
  /** h1 → h3 use accent/info/success, h4+ recede to muted. */
  heading: string[];
  callout: Record<string, string>;
}

function ctxFor(palette: Theme): RenderCtx {
  // Marker/warning colours come from the active theme so light palettes stay
  // readable; no fixed VS Code dark values leak into the transcript.
  return {
    palette,
    marker: palette.accent,
    heading: [palette.accent, palette.info, palette.success, palette.muted, palette.muted, palette.muted],
    callout: {
      ERROR: palette.error,
      WARNING: palette.info,
      WARN: palette.info,
      TIP: palette.success,
      NOTE: palette.info,
      TODO: palette.accent,
      FIXME: palette.error,
    },
  };
}

// Inline alternatives are ordered most-specific first so *** wins over ** over *.
// Escapes come before every marker so `\*` stays literal.
const INLINE_PATTERN =
  /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(!\[[^\]\n]*\]\([^)\n]+\))|(https?:\/\/[^\s)]+)|(\\[*_~`[\]])|(\*\*\*[\s\S]+?\*\*\*)|(\*\*[\s\S]+?\*\*)|(~~[^~\n]+?~~)|(\*[^\s*][^*]*?\*)|(__[^_\n]+?__)|(_[^\s_][^_]*?_)/g;

const FENCE_OPEN = /^\s*(?:```|~~~)\s*([\w.+-]*)\s*$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^(\s*)((?:>\s?)+)(.*)$/;
const TASK = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const UNORDERED = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+\.)\s+(.*)$/;
const CALLOUT = /^\s*(ERROR|WARNING|WARN|TIP|NOTE|TODO|FIXME)\s*:\s*(.*)$/i;

/**
 * Cheap "might need the parser" test. Anything that can start a block or an
 * inline span matches; plain prose (the usual streaming tail) does not.
 */
const MARKDOWN_HINT = /[*_`#>|[\]~]|^\s*(?:\d+\.\s|[-+]\s|[-*_]{3,}\s*$)|https?:\/\//m;

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

/** Nested emphasis: preserve the outer regex cursor across the recursive scan. */
function renderNestedInline(text: string, keyPrefix: string, ctx: RenderCtx): React.ReactNode[] {
  const saved = INLINE_PATTERN.lastIndex;
  const nodes = renderInline(text, keyPrefix, ctx);
  INLINE_PATTERN.lastIndex = saved;
  return nodes;
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
      // Images have no terminal payload: show the alt text as a labelled link.
      const image = match[3];
      const split = image.indexOf('](');
      nodes.push(<Text key={key} color={ctx.palette.info}>{`🖼 ${image.slice(2, split)}`}</Text>);
    } else if (match[4] !== undefined) {
      nodes.push(<Text key={key} color={ctx.palette.info}>{match[4]}</Text>);
    } else if (match[5] !== undefined) {
      nodes.push(match[5].slice(1));
    } else if (match[6] !== undefined) {
      nodes.push(<Text key={key} bold italic>{renderNestedInline(match[6].slice(3, -3), key, ctx)}</Text>);
    } else if (match[7] !== undefined) {
      nodes.push(<Text key={key} bold>{renderNestedInline(match[7].slice(2, -2), key, ctx)}</Text>);
    } else if (match[8] !== undefined) {
      nodes.push(<Text key={key} strikethrough dimColor>{renderNestedInline(match[8].slice(2, -2), key, ctx)}</Text>);
    } else if (match[9] !== undefined) {
      nodes.push(<Text key={key} italic>{renderNestedInline(match[9].slice(1, -1), key, ctx)}</Text>);
    } else if (match[10] !== undefined) {
      nodes.push(<Text key={key} bold>{renderNestedInline(match[10].slice(2, -2), key, ctx)}</Text>);
    } else if (match[11] !== undefined) {
      nodes.push(<Text key={key} italic>{renderNestedInline(match[11].slice(1, -1), key, ctx)}</Text>);
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
export function displayWidth(text: string): number {
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

/**
 * Insert word-boundary line breaks into plain prose so it wraps at the
 * terminal width even when a parent <Text> is truncating. Explicit newlines
 * and blank lines are preserved; wide CJK/emoji count as two columns.
 */
export function wrapPlainText(text: string, columns: number): string {
  if (!Number.isFinite(columns) || columns <= 0) return text;
  const width = Math.max(1, Math.floor(columns));
  return text.split('\n').map((line) => {
    if (displayWidth(line) <= width) return line;
    const out: string[] = [];
    let current = '';
    let currentWidth = 0;
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue;
      const wordWidth = displayWidth(word);
      if (/^\s+$/.test(word)) {
        // Whitespace belongs to the line it follows, never to the next one.
        if (currentWidth + wordWidth <= width) {
          current += word;
          currentWidth += wordWidth;
        }
        continue;
      }
      if (wordWidth > width) {
        // A single long token (URL/path) overflows on its own. Hard-cut it into
        // width-sized pieces with an ellipsis, exactly as table cells do, so a
        // prose reply cannot add unbudgeted rows or paint past the screen edge.
        if (current.trim()) {
          out.push(current.trimEnd());
          current = '';
          currentWidth = 0;
        }
        let rest = word;
        while (displayWidth(rest) > width) {
          if (width <= 1) {
            out.push(truncateToWidth(rest, 1));
            rest = rest.slice(Array.from(rest)[0]?.length ?? 1);
            continue;
          }
          const piece = truncateToWidth(rest, width - 1);
          if (!piece) break; // defensive: never loop forever on a wide glyph
          out.push(`${piece}…`);
          rest = rest.slice(piece.length);
        }
        current = rest;
        currentWidth = displayWidth(rest);
        continue;
      }
      if (currentWidth + wordWidth > width && current.trim()) {
        out.push(current.trimEnd());
        current = '';
        currentWidth = 0;
      }
      current += word;
      currentWidth += wordWidth;
    }
    if (current.trim() || out.length === 0) out.push(current.trimEnd());
    return out.join('\n');
  }).join('\n');
}

/**
 * The text a cell actually paints, with inline markers resolved.
 *
 * Width maths must use this, not the raw markdown: `[a](url)` renders as
 * `a (url)`, so measuring the raw string under-counted the printed width and
 * every column after it drifted out of alignment.
 */
function cellPlainText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      label === url ? label : `${label} (${url})`
    )
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_/g, '$1$2');
}

/** Trim text to a display-column budget (hard cut, used for one long token). */
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

/** Space to add before/after a cell so it fills its column exactly. */
function cellPadding(printed: string, width: number, align: Align): { left: number; right: number } {
  const missing = Math.max(0, width - displayWidth(printed));
  if (align === 'right') return { left: missing, right: 0 };
  if (align === 'center') return { left: Math.floor(missing / 2), right: missing - Math.floor(missing / 2) };
  return { left: 0, right: missing };
}

/**
 * Break a cell into display lines of at most `width` columns.
 *
 * Wrapping (rather than cutting) is what makes a table responsive: on a narrow
 * terminal a long cell grows downward while the table keeps square borders,
 * instead of losing its text or pushing the row past the screen edge.
 */
function wrapCellText(text: string, width: number): string[] {
  if (width <= 0) return [''];
  if (displayWidth(text) <= width) return [text];

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  const words = text.split(/(\s+)/); // keep separators so spacing survives

  const flush = () => {
    if (current.trim() === '') {
      current = '';
      currentWidth = 0;
      return;
    }
    lines.push(current.trimEnd());
    current = '';
    currentWidth = 0;
  };

  for (const word of words) {
    if (!word) continue;
    const wordWidth = displayWidth(word);
    if (currentWidth === 0 && word.trim() === '') continue; // no leading spaces
    if (currentWidth + wordWidth <= width) {
      current += word;
      currentWidth += wordWidth;
      continue;
    }
    if (currentWidth > 0) flush();
    if (wordWidth <= width) {
      current = word.replace(/^\s+/, '');
      currentWidth = displayWidth(current);
      continue;
    }
    // A single token wider than the column: hard-cut it, keeping the ellipsis.
    let rest = word;
    while (displayWidth(rest) > width) {
      const piece = truncateToWidth(rest, Math.max(1, width - 1));
      lines.push(`${piece}…`);
      rest = rest.slice(piece.length);
    }
    current = rest;
    currentWidth = displayWidth(rest);
  }
  flush();
  return lines.length > 0 ? lines : [''];
}

/** A cell ready to paint: `raw` keeps inline markdown, `plain` measures width. */
interface TableCell {
  raw: string;
  plain: string;
}

/** One physical table line: `│ a │ b │` with every cell padded to its column. */
function renderTableLine(
  cells: TableCell[],
  colCount: number,
  widths: number[],
  aligns: Align[],
  key: string,
  isHeader: boolean,
  ctx: RenderCtx
): React.ReactNode {
  const style = isHeader ? { bold: true, color: ctx.palette.accent } : {};
  const parts: React.ReactNode[] = [<Text key={`${key}-edge`} color={ctx.palette.dim}>{'│ '}</Text>];
  for (let ci = 0; ci < colCount; ci++) {
    if (ci > 0) {
      parts.push(<Text key={`${key}-sep${ci}`} color={ctx.palette.dim}>{' │ '}</Text>);
    }
    const cell = cells[ci] ?? { raw: '', plain: '' };
    const pad = cellPadding(cell.plain, widths[ci], aligns[ci]);
    parts.push(
      <Text key={`${key}-c${ci}`} {...style}>
        {pad.left > 0 ? ' '.repeat(pad.left) : null}
        {cell.raw ? renderInline(cell.raw, `${key}-c${ci}-inline`, ctx) : null}
        {pad.right > 0 ? ' '.repeat(pad.right) : null}
      </Text>
    );
  }
  parts.push(<Text key={`${key}-end`} color={ctx.palette.dim}>{' │'}</Text>);
  return <Text key={key}>{parts}</Text>;
}

/**
 * Responsive physical rows for one logical row.
 *
 * A cell that fits is rendered with its inline markdown. A cell that has to
 * wrap falls back to its plain text, because a marker split across two lines
 * would render as literal asterisks.
 */
function renderLogicalRow(
  row: string[],
  colCount: number,
  widths: number[],
  aligns: Align[],
  keyPrefix: string,
  isHeader: boolean,
  ctx: RenderCtx
): React.ReactNode[] {
  const cellLines: TableCell[][] = Array.from({ length: colCount }, (_, ci) => {
    const raw = (row[ci] ?? '').slice(0, MAX_TABLE_CELL_CHARS);
    const plain = cellPlainText(raw);
    const wrapped = wrapCellText(plain, widths[ci]);
    // Inline styling survives only when the cell stays on one line.
    if (wrapped.length <= 1) return [{ raw, plain }];
    return wrapped.map((line) => ({ raw: line, plain: line }));
  });

  const height = Math.max(1, ...cellLines.map((lines) => lines.length));
  const rows: React.ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < height; lineIndex++) {
    const key = `${keyPrefix}-l${lineIndex}`;
    const cells = cellLines.map((lines) => lines[lineIndex] ?? { raw: '', plain: '' });
    rows.push(renderTableLine(cells, colCount, widths, aligns, key, isHeader, ctx));
  }
  return rows;
}

function renderTableDivider(widths: number[], key: string, ctx: RenderCtx): React.ReactNode {
  const segments = widths.map((width) => '─'.repeat(Math.max(1, width + 2)));
  return <Text key={key} color={ctx.palette.dim}>{`├${segments.join('┼')}┤`}</Text>;
}

/** Column widths that fit `columns`, keeping every column readable. */
export function tableColumnWidths(
  naturalWidths: number[],
  columns: number
): number[] {
  const count = Math.max(1, naturalWidths.length);
  const natural = naturalWidths.map((width) => Math.max(1, Math.floor(width || 1)));
  if (!Number.isFinite(columns) || columns <= 0) return natural;

  const overhead = count * 3 + 1; // '│ ' + ' │ ' per column + trailing ' │'
  const budget = Math.floor(columns) - overhead;
  const naturalTotal = natural.reduce((sum, width) => sum + width, 0);
  if (budget >= naturalTotal) return natural;
  if (budget <= count) return natural.map(() => 1);

  // Minimum per column adapts to the space actually available, so a very
  // narrow terminal still fits instead of flooring every column at 3.
  const minCol = Math.max(1, Math.min(3, Math.floor(budget / count)));
  const widths = natural.map((width) =>
    Math.max(minCol, Math.min(width, Math.floor((width * budget) / naturalTotal)))
  );
  let remaining = budget - widths.reduce((sum, width) => sum + width, 0);
  while (remaining > 0) {
    // Hand leftover space to the currently narrowest column: this evens the
    // table out and can never skip past the budget.
    let narrowest = 0;
    for (let i = 1; i < count; i++) if (widths[i] < widths[narrowest]) narrowest = i;
    widths[narrowest] += 1;
    remaining -= 1;
  }
  while (remaining < 0) {
    let widest = 0;
    for (let i = 1; i < count; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 1) break;
    widths[widest] -= 1;
    remaining += 1;
  }
  return widths;
}

function renderTable(table: TableHead, keyPrefix: string, columns = 0, ctx: RenderCtx): React.ReactNode[] {
  const requested = Math.min(
    MAX_TABLE_COLS,
    Math.max(1, table.header.length, ...table.body.map((row) => row.length))
  );
  // Each painted column costs at least three cells ("│ " + " │ "), so a tight
  // width can never host all of them. Drop the tail columns instead of painting
  // a wall of single-cell columns that overruns the frame.
  const knownWidth = Number.isFinite(columns) && columns > 0;
  const affordable = knownWidth
    ? Math.max(1, Math.floor((Math.floor(columns) - 1) / 3))
    : MAX_TABLE_COLS;
  const colCount = Math.max(1, Math.min(requested, affordable));
  const omitted = requested - colCount;
  const cellAt = (row: string[], ci: number): string => (row[ci] ?? '').slice(0, MAX_TABLE_CELL_CHARS);

  // Natural width = widest printed cell in the column (markers resolved).
  const naturalWidths: number[] = [];
  for (let ci = 0; ci < colCount; ci++) {
    let width = displayWidth(cellPlainText(cellAt(table.header, ci)));
    for (const row of table.body) {
      width = Math.max(width, displayWidth(cellPlainText(cellAt(row, ci))));
    }
    naturalWidths.push(Math.min(MAX_TABLE_CELL_CHARS, Math.max(1, width)));
  }

  const widths = tableColumnWidths(naturalWidths, columns);

  const rows: React.ReactNode[] = [
    ...renderLogicalRow(table.header, colCount, widths, table.aligns, `${keyPrefix}-head`, true, ctx),
    renderTableDivider(widths, `${keyPrefix}-div`, ctx),
  ];

  let usedRows = 1;
  for (let i = 0; i < table.body.length; i++) {
    const physical = renderLogicalRow(table.body[i], colCount, widths, table.aligns, `${keyPrefix}-r${i}`, false, ctx);
    if (usedRows + physical.length > MAX_TABLE_OUTPUT_ROWS - 2) {
      const hidden = table.body.length - i;
      rows.push(
        <Text key={`${keyPrefix}-more`} color={ctx.palette.dim}>
          {`  … ${hidden} more row${hidden === 1 ? '' : 's'}`}
        </Text>
      );
      break;
    }
    rows.push(...physical);
    usedRows += physical.length;
  }
  if (omitted > 0) {
    // Keep the note inside the same hard row budget as the table body.
    if (rows.length >= MAX_TABLE_OUTPUT_ROWS) rows.length = MAX_TABLE_OUTPUT_ROWS - 1;
    rows.push(
      <Text key={`${keyPrefix}-cols`} color={ctx.palette.dim}>
        {`  … ${omitted} more column${omitted === 1 ? '' : 's'} omitted`}
      </Text>
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
    // Fast path: no markdown markers and no multi-line constructs means the
    // frame can use the plain string. This is what keeps a long prose reply
    // cheap to re-render on every streamed frame.
    if (!MARKDOWN_HINT.test(capped)) {
      // Even plain text respects the row budget: a wall of prose should not
      // grow the frame without bound.
      const plainLines = capped.split('\n');
      const plain = plainLines.length <= MAX_OUTPUT_ROWS
        ? capped
        : `${plainLines.slice(0, MAX_OUTPUT_ROWS).join('\n')}\n  … ${plainLines.length - MAX_OUTPUT_ROWS} more rows`;
      return wrapPlainText(plain, columns);
    }
    const lines = capped.split('\n');
    const rows: React.ReactNode[] = [];

    let index = 0;
    while (index < lines.length) {
      const line = lines[index];

      const fence = FENCE_OPEN.exec(line);
      if (fence) {
        // Same close rule as splitMarkdownBlocks: the first line with the
        // matching marker ends the code block, even if it has a language tag.
        const marker = fenceMarker(line);
        let end = index + 1;
        while (end < lines.length && fenceMarker(lines[end]) !== marker) {
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
        if (Number.isFinite(columns) && columns > 0 && Math.floor(columns) < 6) {
          // A one-column table still costs four chrome cells; below six columns
          // it cannot fit, so keep the source lines as plain text.
          for (let i = index; i < table.endIndex; i++) {
            rows.push(renderLine(lines[i], `t${index}-p${i}`, ctx));
          }
        } else {
          rows.push(...renderTable(table, `t${index}`, columns, ctx));
        }
        index = table.endIndex;
        continue;
      }

      rows.push(renderLine(line, `l${index}`, ctx));
      index++;
    }

    // Global safety net: many bounded constructs in one message still cannot
    // grow the frame past a fixed number of rows.
    if (rows.length > MAX_OUTPUT_ROWS) {
      const hidden = rows.length - MAX_OUTPUT_ROWS;
      rows.length = MAX_OUTPUT_ROWS;
      rows.push(<Text key="rowcap" color={ctx.palette.dim}>{`  … ${hidden} more rows`}</Text>);
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

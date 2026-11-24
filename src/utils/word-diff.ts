/**
 * Pure, dependency-free word-level diffing for a single pair of changed diff
 * rows. Tokens are words, whitespace runs and individual punctuation marks; an
 * LCS alignment decides which tokens survived between the old and new line.
 *
 * The engine is deliberately defensive: every public function returns a
 * usable result for any input, including non-strings, so it can be called
 * straight from a renderer.
 */

/** One contiguous run of a diff row that changed (or stayed the same). */
export interface WordSegment {
  text: string;
  changed: boolean;
}

/** Beyond these limits an LCS table is not worth building. */
const MAX_TOKENS = 400;
const MAX_CHARS = 4000;
/** Upper bound on segments returned for each side. */
const MAX_SEGMENTS = 200;

/** Tokenize into words (incl. unicode letters/marks), whitespace and punctuation. */
const TOKEN_RE = /\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu;

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) tokens.push(match[0]);
  return tokens;
}

/** Whole-line fallback: never mark an empty line, and never throw. */
function wholeLine(text: string): WordSegment[] {
  return text.length > 0 ? [{ text, changed: true }] : [];
}

function unchangedLine(text: string): WordSegment[] {
  return text.length > 0 ? [{ text, changed: false }] : [];
}

/** Longest-common-subsequence alignment over the two token arrays. */
function alignTokens(oldTokens: string[], newTokens: string[]): { oldChanged: boolean[]; newChanged: boolean[] } {
  const n = oldTokens.length;
  const m = newTokens.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = oldTokens[i] === newTokens[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const oldChanged = new Array<boolean>(n).fill(false);
  const newChanged = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j] && lcs[i * width + j] === lcs[(i + 1) * width + j + 1]! + 1) {
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      oldChanged[i++] = true;
    } else {
      newChanged[j++] = true;
    }
  }
  while (i < n) oldChanged[i++] = true;
  while (j < m) newChanged[j++] = true;
  return { oldChanged, newChanged };
}

/**
 * Reduce a segment list to the cap without losing any text. Prefer merging
 * neighbours with the same flag (harmless), then mixed pairs only if needed.
 */
function capSegments(segments: WordSegment[]): WordSegment[] {
  const result = segments.slice();
  while (result.length > MAX_SEGMENTS) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i]!;
      const b = result[i + 1]!;
      // 0: both unchanged, 1: both changed, 2: mixed (bolds extra text).
      const score = a.changed === b.changed ? (a.changed ? 1 : 0) : 2;
      if (score < bestScore) {
        bestScore = score;
        best = i;
        if (score === 0) break;
      }
    }
    if (best < 0) break;
    const merged: WordSegment = {
      text: result[best]!.text + result[best + 1]!.text,
      changed: result[best]!.changed || result[best + 1]!.changed,
    };
    result[best] = merged;
    result.splice(best + 1, 1);
  }
  return result;
}

/** Merge adjacent tokens sharing a flag, then apply the segment cap. */
function buildSegments(tokens: string[], changed: boolean[]): WordSegment[] {
  const segments: WordSegment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]!;
    const flag = changed[i] === true;
    const last = segments[segments.length - 1];
    if (last && last.changed === flag) last.text += text;
    else segments.push({ text, changed: flag });
  }
  return capSegments(segments);
}

/**
 * Word-level diff of two diff-row texts. Concatenating `old` always yields
 * exactly `oldText`, and concatenating `new` exactly `newText`.
 *
 * Large inputs (either side over 400 tokens or 4000 characters) fall back to
 * one whole-line changed segment per non-empty side; identical texts are left
 * wholly unchanged instead.
 */
export function diffWords(oldText: string, newText: string): { old: WordSegment[]; new: WordSegment[] } {
  const before = asString(oldText);
  const after = asString(newText);
  try {
    if (before === after) {
      const shared = unchangedLine(before);
      return { old: shared.map((segment) => ({ ...segment })), new: shared.map((segment) => ({ ...segment })) };
    }

    const oldTokens = tokenize(before);
    const newTokens = tokenize(after);
    if (
      oldTokens.length > MAX_TOKENS
      || newTokens.length > MAX_TOKENS
      || before.length > MAX_CHARS
      || after.length > MAX_CHARS
    ) {
      return { old: wholeLine(before), new: wholeLine(after) };
    }

    const { oldChanged, newChanged } = alignTokens(oldTokens, newTokens);
    return {
      old: buildSegments(oldTokens, oldChanged),
      new: buildSegments(newTokens, newChanged),
    };
  } catch {
    return { old: wholeLine(before), new: wholeLine(after) };
  }
}

/**
 * Pull just the highlighted parts out of a segment list. If no usable
 * segments are supplied, the whole text is treated as changed so callers
 * still get a meaningful result. Never throws.
 */
export function changedSegments(text: string, segments: WordSegment[]): WordSegment[] {
  const source = asString(text);
  try {
    if (!Array.isArray(segments) || segments.length === 0) {
      return source.length > 0 ? [{ text: source, changed: true }] : [];
    }
    const changed: WordSegment[] = [];
    for (const segment of segments) {
      if (segment && typeof segment.text === 'string' && segment.changed === true && segment.text.length > 0) {
        changed.push({ text: segment.text, changed: true });
      }
    }
    return changed;
  } catch {
    return source.length > 0 ? [{ text: source, changed: true }] : [];
  }
}

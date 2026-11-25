/**
 * fuzzy.ts — small, defensive fuzzy matcher for the slash palette and @ picker.
 *
 * Inspired by fzf's extended search: whitespace-separated terms are ANDed,
 * `^abc` anchors a prefix, `abc$` anchors a suffix, `'abc` is an exact
 * substring, and `!abc` negates a term. Plain terms use case-insensitive
 * subsequence matching with bonuses for contiguous runs, word boundaries and
 * exact substrings, so typing "gf" still finds "get_file" while "get" ranks
 * it above "git_edit".
 *
 * The matcher never throws and caps its work on pathological input.
 */

export interface FuzzyScore {
  score: number;
  /** Character indices in the original text that matched, for highlighting. */
  indices: number[];
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
  indices: number[];
}

const MAX_TEXT_CHARS = 4_000;
const MAX_QUERY_CHARS = 200;

function wordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === ' ' || prev === '_' || prev === '-' || prev === '/' || prev === '.' || prev === ':';
}

/** Score one plain term against one text. Returns null when it does not match. */
export function fuzzyScore(query: string, text: string): FuzzyScore | null {
  if (typeof query !== 'string' || typeof text !== 'string') return null;
  const q = query.slice(0, MAX_QUERY_CHARS).toLowerCase();
  const t = text.slice(0, MAX_TEXT_CHARS).toLowerCase();
  if (!q) return { score: 0, indices: [] };
  if (q.length > t.length) return null;

  const direct = t.indexOf(q);
  if (direct >= 0) {
    const indices: number[] = [];
    for (let i = 0; i < q.length; i++) indices.push(direct + i);
    let score = 1_000 - direct * 2 + q.length * 10;
    if (direct === 0) score += 400;
    if (wordBoundary(t, direct)) score += 120;
    return { score, indices };
  }

  const indices: number[] = [];
  let cursor = 0;
  let score = 0;
  let streak = 0;
  let gap = 0;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found < 0) return null;
    if (found === cursor && indices.length > 0) {
      streak += 1;
      score += 20 + streak * 8;
    } else {
      streak = 0;
      gap = found - cursor;
      score += 8 - Math.min(gap, 8);
      if (wordBoundary(t, found)) score += 30;
    }
    indices.push(found);
    cursor = found + 1;
  }
  // Prefer matches that start early and finish early.
  score -= indices[0] * 2;
  score -= Math.max(0, t.length - cursor) / 20;
  return { score, indices };
}

interface Term {
  kind: 'plain' | 'prefix' | 'suffix' | 'exact' | 'negate';
  value: string;
}

function parseTerms(query: string): Term[] {
  return query
    .slice(0, MAX_QUERY_CHARS)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw): Term => {
      if (raw.startsWith('!') && raw.length > 1) return { kind: 'negate', value: raw.slice(1) };
      if (raw.startsWith("'") && raw.length > 1) {
        return { kind: raw.endsWith("'") && raw.length > 2 ? 'exact' : 'plain', value: raw.replace(/^'|'$/g, '') };
      }
      if (raw.startsWith('^') && raw.length > 1) return { kind: 'prefix', value: raw.slice(1) };
      if (raw.endsWith('$') && raw.length > 1) return { kind: 'suffix', value: raw.slice(0, -1) };
      return { kind: 'plain', value: raw };
    });
}

/** Match a full query (all terms) against one string. */
export function fuzzyMatch(query: string, text: string): FuzzyScore | null {
  const terms = parseTerms(query);
  if (terms.length === 0) return { score: 0, indices: [] };
  const lower = text.slice(0, MAX_TEXT_CHARS).toLowerCase();
  let total = 0;
  const indices = new Set<number>();

  for (const term of terms) {
    if (!term.value) continue;
    const needle = term.value.toLowerCase();
    if (term.kind === 'negate') {
      if (lower.includes(needle)) return null;
      continue;
    }
    if (term.kind === 'exact') {
      const at = lower.indexOf(needle);
      if (at < 0) return null;
      for (let i = 0; i < needle.length; i++) indices.add(at + i);
      total += 600 + needle.length * 10;
      continue;
    }
    if (term.kind === 'prefix') {
      if (!lower.startsWith(needle)) return null;
      for (let i = 0; i < needle.length; i++) indices.add(i);
      total += 800 + needle.length * 10;
      continue;
    }
    if (term.kind === 'suffix') {
      if (!lower.endsWith(needle)) return null;
      for (let i = 0; i < needle.length; i++) indices.add(lower.length - needle.length + i);
      total += 700 + needle.length * 10;
      continue;
    }
    const match = fuzzyScore(needle, lower);
    if (!match) return null;
    total += match.score;
    for (const index of match.indices) indices.add(index);
  }
  return { score: total, indices: [...indices].sort((a, b) => a - b) };
}

/**
 * Filter and rank items by a query. `getText` supplies the primary label;
 * `getAlias` can add keywords/descriptions that influence ranking but are not
 * highlighted. Original order breaks score ties.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  options: { getText: (item: T) => string; getAlias?: (item: T) => string; limit?: number }
): FuzzyResult<T>[] {
  const out: FuzzyResult<T>[] = [];
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : items.length;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let text = '';
    try {
      text = options.getText(item) ?? '';
    } catch {
      text = '';
    }
    let best = fuzzyMatch(query, text);
    if (!best && options.getAlias) {
      let alias = '';
      try {
        alias = options.getAlias(item) ?? '';
      } catch {
        alias = '';
      }
      // Alias matches score lower so the visible label still wins ties.
      const aliasMatch = fuzzyMatch(query, alias);
      if (aliasMatch) best = { score: aliasMatch.score / 2, indices: [] };
    }
    if (best) out.push({ item, score: best.score, indices: best.indices, order: index } as FuzzyResult<T> & { order: number });
  }
  out.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 0.001) return diff;
    return (a as FuzzyResult<T> & { order: number }).order - (b as FuzzyResult<T> & { order: number }).order;
  });
  return limit > 0 ? out.slice(0, limit) : out;
}

/** Render a label with matched characters wrapped in `[...]` for testing. */
export function highlightMatches(text: string, indices: readonly number[]): string {
  const set = new Set(indices);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (set.has(i)) out += `[${char}]`;
    else out += char;
  }
  return out;
}

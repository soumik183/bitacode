/**
 * edit_file tool — Find-and-replace in an existing file. Requires approval.
 *
 * Uses a fuzzy match cascade of 5 strategies to find the old_string,
 * tolerating minor whitespace discrepancies from the model.
 * Returns a unified diff on success so the model can verify its edit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';
import { assertWritablePath } from '../utils/protected-paths.js';
import { findSimilarPaths } from '../utils/path-suggestions.js';
import { requestApproval } from '../utils/approval.js';
import { checkReadBefore, recordRead } from '../utils/file-time.js';
import { computeUnifiedDiff } from '../utils/unified-diff.js';

export const editFileTool = {
  type: 'function' as const,
  function: {
    name: 'edit_file',
    description:
      'Edit an existing file by replacing an exact string match with new content. ' +
      'The old_string must match exactly (including whitespace and indentation). ' +
      'Always read the file first to get the exact content to replace.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit.' },
        old_string: { type: 'string', description: 'The exact text to find and replace.' },
        new_string: { type: 'string', description: 'The text to replace it with.' },
        expected_replacements: {
          type: 'number',
          description: 'Expected number of replacements (default 1). Fails if actual count differs.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
};

// ─── Fuzzy Match Strategies ───

/** An exact region in the file content that a strategy resolved old_string to. */
interface Match {
  /** Start index of `text` in the original file content. */
  index: number;
  /** Exact substring in the file to be replaced. */
  text: string;
}

interface MatchStrategy {
  name: string;
  /** Return every region in `content` that matches `oldString` under this strategy. */
  findMatches(content: string, oldString: string): Match[];
}

/** Character offset of each line's first character in `content`. */
function lineStartOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1; // +1 for the '\n' separator
  }
  return offsets;
}

/** All non-overlapping indices of `needle` in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    indices.push(idx);
    idx += Math.max(needle.length, 1);
  }
  return indices;
}

/** Strategy 1: Exact verbatim match (current behavior). */
const exactReplacer: MatchStrategy = {
  name: 'exact',
  findMatches(content, oldString) {
    return indicesOf(content, oldString).map(index => ({ index, text: oldString }));
  },
};

/** Strategy 2: Per-line .trim() comparison — uses file's actual indentation. */
const lineTrimmedReplacer: MatchStrategy = {
  name: 'line-trimmed',
  findMatches(content, oldString) {
    const searchLines = oldString.split('\n').map(l => l.trim());
    const contentLines = content.split('\n');
    const offsets = lineStartOffsets(contentLines);
    const matches: Match[] = [];

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        matches.push({ index: offsets[i], text: contentLines.slice(i, i + searchLines.length).join('\n') });
      }
    }
    return matches;
  },
};

/** Strategy 3: Strip common leading indent from both before comparing. */
const indentFlexReplacer: MatchStrategy = {
  name: 'indent-flexible',
  findMatches(content, oldString) {
    const oldLines = oldString.split('\n');
    const commonIndent = getCommonIndent(oldLines);
    if (commonIndent === 0) return [];

    const stripped = oldLines.map(l => l.slice(commonIndent)).join('\n');
    const contentLines = content.split('\n');
    const offsets = lineStartOffsets(contentLines);
    const matches: Match[] = [];

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const fileSlice = contentLines.slice(i, i + oldLines.length);
      const fileCommonIndent = getCommonIndent(fileSlice);
      const fileStripped = fileSlice.map(l => l.slice(fileCommonIndent)).join('\n');

      if (fileStripped === stripped) {
        matches.push({ index: offsets[i], text: fileSlice.join('\n') });
      }
    }
    return matches;
  },
};

/** Strategy 4: Collapse all whitespace runs to single space before comparing. */
const whitespaceNormReplacer: MatchStrategy = {
  name: 'whitespace-normalized',
  findMatches(content, oldString) {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const target = normalize(oldString);
    if (!target) return [];

    const contentLines = content.split('\n');
    const offsets = lineStartOffsets(contentLines);
    const oldLineCount = oldString.split('\n').length;
    const matches: Match[] = [];

    for (let i = 0; i <= contentLines.length - oldLineCount; i++) {
      const window = contentLines.slice(i, i + oldLineCount).join('\n');
      if (normalize(window) === target) {
        matches.push({ index: offsets[i], text: window });
      }
    }
    return matches;
  },
};

/** Strategy 5: .trim() the entire oldString before searching. */
const trimmedBoundaryReplacer: MatchStrategy = {
  name: 'trimmed-boundary',
  findMatches(content, oldString) {
    const trimmed = oldString.trim();
    if (trimmed === oldString) return []; // no change from exact
    return indicesOf(content, trimmed).map(index => ({ index, text: trimmed }));
  },
};

const STRATEGIES: MatchStrategy[] = [
  exactReplacer,
  lineTrimmedReplacer,
  indentFlexReplacer,
  whitespaceNormReplacer,
  trimmedBoundaryReplacer,
];

function getCommonIndent(lines: string[]): number {
  let min = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue; // skip blank lines
    const indent = line.length - line.trimStart().length;
    min = Math.min(min, indent);
  }
  return min === Infinity ? 0 : min;
}

type CascadeOutcome =
  | { kind: 'match'; matches: Match[]; strategy: string }
  | { kind: 'ambiguous'; strategy: string; lines: number[] }
  | { kind: 'wrong-count'; count: number; strategy: string }
  | { kind: 'not-found' };

/**
 * Try each strategy in order. A strategy is accepted only when all of its
 * matches resolve to the same exact text (unambiguous) and their count equals
 * the expected replacement count. Fuzzy matches that resolve to different
 * regions are reported as ambiguous instead of being silently applied.
 */
function findWithCascade(
  content: string,
  oldString: string,
  expectedReplacements: number,
): CascadeOutcome {
  let wrongCount: { count: number; strategy: string } | null = null;

  for (const strategy of STRATEGIES) {
    const matches = strategy.findMatches(content, oldString);
    if (matches.length === 0) continue;

    // Distinct resolved texts mean the fuzzy match could target different
    // blocks. Editing one (or all) would silently touch the wrong region.
    const distinctTexts = new Set(matches.map(m => m.text));
    if (distinctTexts.size > 1) {
      const lines = matches.map(m => content.slice(0, m.index).split('\n').length);
      return { kind: 'ambiguous', strategy: strategy.name, lines };
    }

    const count = matches.length;
    if (count === expectedReplacements) {
      return { kind: 'match', matches, strategy: strategy.name };
    }
    if (wrongCount === null) wrongCount = { count, strategy: strategy.name };
  }

  return wrongCount ? { kind: 'wrong-count', ...wrongCount } : { kind: 'not-found' };
}

// ─── Main editFile function ───

export async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  expectedReplacements = 1,
  sessionId?: string,
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return 'Error: file_path is required.';
  }
  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    return 'Error: old_string and new_string must be strings.';
  }
  if (oldString.length === 0) {
    return 'Error: old_string cannot be empty.';
  }

  const expected = expectedReplacements == null ? 1 : Math.floor(Number(expectedReplacements));
  if (!Number.isFinite(expected) || expected < 1) {
    return 'Error: expected_replacements must be a positive integer.';
  }

  let validated: string;
  try {
    validated = await validatePath(filePath);
    assertWritablePath(validated);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  let stat;
  try {
    stat = await fs.stat(validated);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      const suggestions = await findSimilarPaths(filePath);
      let msg = `File not found: '${filePath}'.`;
      if (suggestions.length > 0) {
        msg += ' Did you mean one of these?\n' + suggestions.map(s => `  ${s}`).join('\n');
      }
      return msg;
    }
    return `Error: cannot access '${filePath}': ${err.message}`;
  }

  if (stat.isDirectory()) {
    return `Error: '${filePath}' is a directory. Use list_directory to inspect its contents.`;
  }
  if (!stat.isFile()) {
    return `Error: '${filePath}' is not a regular file.`;
  }

  // Staleness guard: must have read file before editing
  if (sessionId) {
    const staleError = checkReadBefore(sessionId, validated);
    if (staleError) return staleError;
  }

  // Check file size before reading to avoid OOM on huge files
  const MAX_EDIT_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
  if (stat.size > MAX_EDIT_FILE_SIZE) {
    return `Error: file is too large to edit (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit is ${MAX_EDIT_FILE_SIZE / 1024 / 1024} MB).`;
  }

  const content = await fs.readFile(validated, 'utf8');

  // Use fuzzy match cascade
  const outcome = findWithCascade(content, oldString, expected);

  if (outcome.kind === 'ambiguous') {
    return `Error: ambiguous match — old_string matches multiple distinct regions via ${outcome.strategy} at line(s) ${outcome.lines.join(', ')}. Make old_string more specific so it targets a single block.`;
  }
  if (outcome.kind === 'wrong-count') {
    return `Error: found ${outcome.count} occurrence(s) of old_string (via ${outcome.strategy} match), but expected ${expected}. Be more specific or set expected_replacements=${outcome.count}.`;
  }
  if (outcome.kind === 'not-found') {
    // Build a per-strategy diagnostic to help the model self-correct without
    // requiring a full re-read. For each strategy, find the closest partial
    // match and report ALL lines where it diverges (not just the first).
    const searchLines = oldString.split('\n');
    const contentLines = content.split('\n');
    const diagnostics: string[] = [];

    for (const strategy of STRATEGIES) {
      // Find the window in the file that shares the most lines with oldString
      let bestWindowStart = -1;
      let bestMatchedLines = 0;

      for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let matched = 0;
        for (let j = 0; j < searchLines.length; j++) {
          const fileLine = strategy.name === 'whitespace-normalized'
            ? contentLines[i + j].replace(/\s+/g, ' ').trim()
            : contentLines[i + j].trim();
          const searchLine = strategy.name === 'whitespace-normalized'
            ? searchLines[j].replace(/\s+/g, ' ').trim()
            : searchLines[j].trim();
          if (fileLine === searchLine) matched++;
        }
        if (matched > bestMatchedLines) {
          bestMatchedLines = matched;
          bestWindowStart = i;
        }
      }

      if (bestWindowStart >= 0 && bestMatchedLines > 0 && bestMatchedLines < searchLines.length) {
        // Collect all diverging lines, not just the first
        const diffLines: string[] = [];
        const MAX_DIFFS = 6;
        for (let j = 0; j < searchLines.length && diffLines.length < MAX_DIFFS; j++) {
          const fileLine = contentLines[bestWindowStart + j] ?? '(end of file)';
          const searchLine = searchLines[j];
          const fileNorm = strategy.name === 'whitespace-normalized'
            ? fileLine.replace(/\s+/g, ' ').trim()
            : fileLine.trim();
          const searchNorm = strategy.name === 'whitespace-normalized'
            ? searchLine.replace(/\s+/g, ' ').trim()
            : searchLine.trim();
          if (fileNorm !== searchNorm) {
            diffLines.push(
              `    line ${bestWindowStart + j + 1}:\n` +
              `      yours: ${searchLine.trim().slice(0, 120)}\n` +
              `      file:  ${fileLine.trim().slice(0, 120)}`
            );
          }
        }
        const truncNote = diffLines.length === MAX_DIFFS ? `\n    ... (more diffs not shown)` : '';
        diagnostics.push(
          `  ${strategy.name}: ${bestMatchedLines}/${searchLines.length} lines match, ${searchLines.length - bestMatchedLines} differ:\n` +
          diffLines.join('\n') + truncNote
        );
      } else if (bestMatchedLines === 0) {
        diagnostics.push(`  ${strategy.name}: no lines matched — old_string may be from a different file or heavily rewritten`);
      } else {
        diagnostics.push(`  ${strategy.name}: no partial match found`);
      }
    }

    const hint = diagnostics.length > 0
      ? '\nDiagnostics per strategy:\n' + diagnostics.join('\n')
      : '';
    return `Error: old_string not found in ${filePath}.${hint}\nDo NOT retry with a guess. Call read_file on ${filePath} first to get the exact current content, then construct old_string by copying verbatim from the file.`;
  }

  const { matches, strategy } = outcome;
  const count = matches.length;

  // Request approval
  const oldPreview = oldString.length > 200 ? oldString.slice(0, 200) + '...' : oldString;
  const newPreview = newString.length > 200 ? newString.slice(0, 200) + '...' : newString;
  const strategyNote = strategy !== 'exact' ? ` [matched via ${strategy}]` : '';

  const approved = await requestApproval({
    id: `edit-${Date.now()}`,
    type: 'file_edit',
    description: `Edit file: ${filePath} (${count} replacement${count > 1 ? 's' : ''})${strategyNote}`,
    detail: `Replace:\n${oldPreview}\n\nWith:\n${newPreview}`,
    sessionId,
    sessionScopeKey: `file_edit:${validated}`,
  });

  if (!approved) {
    return `Operation cancelled: edit to ${filePath} was rejected by user.`;
  }

  // Replace each matched region by its exact index, working backwards so
  // earlier indices stay valid. Never use split/join: a fuzzy-resolved
  // substring may also appear elsewhere and must not be edited there.
  let newContent = content;
  for (const match of [...matches].sort((a, b) => b.index - a.index)) {
    newContent = newContent.slice(0, match.index) + newString + newContent.slice(match.index + match.text.length);
  }
  const directory = path.dirname(validated);
  const tempPath = path.join(directory, `.bitacode-edit-${process.pid}-${Date.now()}-${path.basename(validated)}`);
  try {
    await fs.writeFile(tempPath, newContent, { encoding: 'utf8', mode: stat.mode & 0o777 });
    await fs.rename(tempPath, validated);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  // Re-read file after write (captures any formatter changes)
  // Also record the read so subsequent edits don't fail the mtime check
  const finalContent = await fs.readFile(validated, 'utf8');
  if (sessionId) {
    recordRead(sessionId, validated);
  }

  // Compute and return unified diff
  const diff = computeUnifiedDiff(content, finalContent, filePath);
  const header = `Successfully edited ${filePath}: ${count} replacement(s) made.`;

  if (diff) {
    return `${header}\n${diff}`;
  }
  return header;
}

/**
 * rules.ts — repository instruction files, merged the way users expect.
 *
 * Unlike the old "first AGENTS.md found wins" lookup, this collects every
 * instruction file from the filesystem root down to the working directory so
 * the nearest one is applied last, adds the global `~/.config/bitacode` files,
 * expands `@path` imports, and reads ecosystem rule files (`.cursorrules`,
 * `.windsurfrules`, `.clinerules`, `.bitacode/rules/*.md`, `.claude/rules/*.md`).
 *
 * Everything is best-effort, bounded and never throws: a bad file is skipped
 * and reported as a warning, not a fatal error.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type InstructionSource = 'global' | 'project' | 'compat' | 'rules';

export interface InstructionChunk {
  /** Human-readable origin, usually a relative or `~`-shortened path. */
  label: string;
  source: InstructionSource;
  text: string;
}

export interface InstructionContext {
  chunks: InstructionChunk[];
  warnings: string[];
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const COMPAT_FILES = ['.cursorrules', '.windsurfrules', '.clinerules'] as const;
const RULES_DIRS = [path.join('.bitacode', 'rules'), path.join('.claude', 'rules')] as const;
const MAX_TOTAL_CHARS = 32_000;
const MAX_FILE_CHARS = 12_000;
const MAX_IMPORT_DEPTH = 3;

async function readIfFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    const text = await fs.readFile(file, 'utf8');
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : text;
  } catch {
    return null;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((entry) => entry.endsWith('.md')).sort().map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** Split optional `---` frontmatter; keep `paths:` as an applicability note. */
function stripFrontmatter(raw: string): { body: string; appliesTo?: string } {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { body: text.trim() };
  const header = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n/, '').trim();
  let appliesTo: string | undefined;
  for (const line of header.split('\n')) {
    const match = line.match(/^\s*paths?\s*:\s*(.+)$/i);
    if (match) {
      appliesTo = match[1].trim().replace(/^\[|\]$/g, '');
      break;
    }
  }
  return appliesTo ? { body, appliesTo } : { body };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Expand `@path` imports relative to the file, bounded by the repo root. */
async function expandImports(
  text: string,
  baseDir: string,
  root: string,
  depth: number,
  seen: Set<string>,
  warnings: string[],
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return text;
  const pattern = /(^|[\s(])@([^\s@)]+)/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const token = match[2].trim();
    result += text.slice(lastIndex, match.index) + prefix;
    lastIndex = match.index + match[0].length;

    const target = path.resolve(baseDir, token);
    if (!isInside(root, target)) {
      result += `@${token}`;
      continue;
    }
    const absolute = path.normalize(target);
    if (seen.has(absolute)) {
      result += `(already imported: ${token})`;
      continue;
    }
    const imported = await readIfFile(absolute);
    if (imported === null) {
      result += `@${token}`;
      continue;
    }
    seen.add(absolute);
    const nested = await expandImports(imported, path.dirname(absolute), root, depth + 1, seen, warnings);
    warnings.push(`imported ${path.relative(root, absolute)}`);
    result += nested;
  }

  result += text.slice(lastIndex);
  return result;
}

async function loadChunk(
  file: string,
  source: InstructionSource,
  root: string,
  label: string | undefined,
  seen: Set<string>,
  warnings: string[],
): Promise<InstructionChunk | null> {
  const absolute = path.normalize(path.resolve(file));
  if (seen.has(absolute)) return null;
  const raw = await readIfFile(absolute);
  if (raw === null) return null;
  seen.add(absolute);
  const { body, appliesTo } = stripFrontmatter(raw);
  if (!body) return null;
  const fileDir = path.dirname(absolute);
  // Imports are confined to the instruction file's own subtree: an AGENTS.md in
  // a parent project may import `./docs/style.md` even when the agent runs in a
  // nested directory, but `@../..`-style escapes are refused.
  const expanded = await expandImports(body, fileDir, fileDir, 0, seen, warnings);
  const note = appliesTo ? `\n(applies to paths: ${appliesTo})` : '';
  const chunkLabel = label ?? (path.relative(root, absolute) || absolute);
  return { label: chunkLabel, source, text: `${expanded}${note}` };
}

function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse(); // root first, nearest last
}

/**
 * Collect instruction context for `cwd`. Global files come first, then each
 * ancestor directory from root to cwd, then compatibility files and rules
 * directories at the working directory.
 */
export async function loadInstructionContext(
  options: { cwd?: string; home?: string } = {},
): Promise<InstructionContext> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = options.home ?? os.homedir();
  const seen = new Set<string>();
  const warnings: string[] = [];
  const chunks: InstructionChunk[] = [];

  const globalDir = path.join(home, '.config', 'bitacode');
  for (const name of INSTRUCTION_FILES) {
    const chunk = await loadChunk(path.join(globalDir, name), 'global', cwd, `~/.config/bitacode/${name}`, seen, warnings);
    if (chunk) chunks.push(chunk);
  }

  for (const dir of ancestors(cwd)) {
    for (const name of INSTRUCTION_FILES) {
      const chunk = await loadChunk(path.join(dir, name), 'project', cwd, undefined, seen, warnings);
      if (chunk) chunks.push(chunk);
    }
  }

  for (const name of COMPAT_FILES) {
    const chunk = await loadChunk(path.join(cwd, name), 'compat', cwd, name, seen, warnings);
    if (chunk) chunks.push(chunk);
  }

  for (const dir of RULES_DIRS) {
    for (const file of await listMarkdown(path.join(cwd, dir))) {
      const chunk = await loadChunk(file, 'rules', cwd, path.relative(cwd, file), seen, warnings);
      if (chunk) chunks.push(chunk);
    }
  }

  // Keep the prompt bounded. Chunks are ordered global -> nearest -> compat ->
  // rules, so when the budget is exceeded drop from the front and keep the most
  // specific instructions (the tail of `chunks`).
  const kept = [...chunks];
  let total = kept.reduce((sum, chunk) => sum + chunk.text.length, 0);
  while (total > MAX_TOTAL_CHARS && kept.length > 0) {
    const dropped = kept.shift();
    if (!dropped) break;
    total -= dropped.text.length;
    warnings.push(`instruction budget reached; skipped ${dropped.label}`);
  }

  return { chunks: kept, warnings };
}

/** Prompt section for instruction chunks; empty when there are none. */
export function renderInstructionContext(context: InstructionContext): string {
  if (context.chunks.length === 0) return '';
  const parts = context.chunks.map((chunk) => `## ${chunk.label}\n\n${chunk.text}`);
  return `\n# INSTRUCTIONS\n\nThe following repository instructions apply. Nearest files are most specific.\n\n${parts.join('\n\n')}\n`;
}

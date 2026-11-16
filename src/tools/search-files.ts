/**
 * search_files tool — Recursive text search across files.
 *
 * Uses ripgrep (rg) when available for fast, .gitignore-aware searching.
 * Falls back to a pure JS recursive directory walk if rg is not found.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorkingDirectory, validatePath } from '../utils/path-validation.js';

const execFileAsync = promisify(execFile);

export const searchFilesTool = {
  type: 'function' as const,
  function: {
    name: 'search_files',
    description: 'Search for a text pattern across files in a directory (recursive). Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        search_term: { type: 'string', description: 'The text or regex pattern to search for.' },
        directory_path: { type: 'string', description: 'Directory to search in. Defaults to ".".' },
        file_extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by file extensions, e.g. [".ts", ".js"]. Searches all files if omitted.',
        },
        case_sensitive: { type: 'boolean', description: 'Whether the search is case-sensitive. Defaults to true.' },
      },
      required: ['search_term'],
    },
  },
};

// Detect ripgrep availability at module load
let hasRipgrep = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
  hasRipgrep = true;
} catch {
  // ripgrep not available, will use JS fallback
}

const MAX_RESULTS = 100;
const MAX_PATTERN_LENGTH = 1000;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB, matches rg --max-filesize

// Directories to skip during recursive search
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.nox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.hypothesis',
  '.next',
  'out',
  '.turbo',
  '.cache',
]);

/** Accept both "ts" and ".ts" from the model. */
function normalizeExtensions(fileExtensions?: string[]): Set<string> | undefined {
  if (!Array.isArray(fileExtensions) || fileExtensions.length === 0) return undefined;

  const normalized = fileExtensions
    .filter((ext): ext is string => typeof ext === 'string' && ext.length > 0)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  return normalized.length > 0 ? new Set(normalized) : undefined;
}

/** Paths are returned relative to the working directory so they can be passed straight to read_file. */
function displayPath(absolutePath: string): string {
  return path.relative(getWorkingDirectory(), absolutePath).split(path.sep).join('/');
}

export async function searchFiles(
  searchTerm: string,
  directoryPath = '.',
  caseSensitive = true,
  fileExtensions?: string[],
  abortSignal?: AbortSignal,
): Promise<string> {
  if (typeof searchTerm !== 'string' || searchTerm.length === 0) {
    return 'Error: search_term is required.';
  }
  if (searchTerm.length > MAX_PATTERN_LENGTH) {
    return `Error: Pattern too long (${searchTerm.length} chars, max ${MAX_PATTERN_LENGTH})`;
  }

  let validated: string;
  try {
    validated = await validatePath(directoryPath || '.');
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  let stats;
  try {
    stats = await fs.stat(validated);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return `Directory not found: '${directoryPath}'`;
    }
    return `Error: cannot access '${directoryPath}': ${err.message}`;
  }

  if (!stats.isDirectory()) {
    return `Error: '${directoryPath}' is not a directory. Pass a directory to search in.`;
  }

  const extensions = normalizeExtensions(fileExtensions);
  if (hasRipgrep) {
    return searchWithRipgrep(searchTerm, validated, directoryPath, caseSensitive !== false, extensions, abortSignal);
  }
  return searchWithJs(searchTerm, validated, directoryPath, caseSensitive !== false, extensions);
}

// ─── Ripgrep implementation ───

async function searchWithRipgrep(
  searchTerm: string,
  validated: string,
  directoryPath: string,
  caseSensitive: boolean,
  extensions: Set<string> | undefined,
  abortSignal?: AbortSignal,
): Promise<string> {
  const args: string[] = [
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color=never',
    '--max-filesize=1M',
  ];

  if (!caseSensitive) {
    args.push('--ignore-case');
  }

  if (extensions) {
    for (const ext of extensions) {
      args.push(`--glob=*${ext}`);
    }
  }

  args.push('--regexp', searchTerm, validated);

  try {
    const { stdout } = await execFileAsync('rg', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      signal: abortSignal,
    }) as { stdout: string; stderr: string };

    const lines = stdout.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      return `No matches found for "${searchTerm}" in ${directoryPath}`;
    }

    const results: string[] = [];
    for (const line of lines) {
      if (results.length >= MAX_RESULTS) break;

      // rg output: filepath:linenum:content
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;

      const filePath = line.slice(0, firstColon);
      const lineNum = line.slice(firstColon + 1, secondColon);
      let content = line.slice(secondColon + 1).trim();

      if (content.length > 500) {
        content = content.slice(0, 500) + '... (truncated)';
      }

      results.push(`${displayPath(path.resolve(filePath))}:${lineNum}: ${content}`);
    }

    const suffix = lines.length > MAX_RESULTS ? `\n(results truncated at ${MAX_RESULTS})` : '';
    return `Found ${results.length} match(es) for "${searchTerm}":\n${results.join('\n')}${suffix}`;

  } catch (err: any) {
    if (err.name === 'AbortError' || err.killed) {
      return `Search aborted: "${searchTerm}"`;
    }

    const status = typeof err.code === 'number' ? err.code : err.status;

    // rg exits with code 1 if no matches found (not an error)
    if (status === 1) {
      return `No matches found for "${searchTerm}" in ${directoryPath}`;
    }
    // rg exits with code 2 for actual errors
    if (status === 2) {
      const msg = err.stderr?.toString() || err.message;
      return `Error: ripgrep error: ${msg}`;
    }
    // Fall back to JS search on any other error
    return searchWithJs(searchTerm, validated, directoryPath, caseSensitive, extensions);
  }
}

// ─── JS fallback implementation ───

async function searchWithJs(
  searchTerm: string,
  validated: string,
  directoryPath: string,
  caseSensitive: boolean,
  extensions: Set<string> | undefined,
): Promise<string> {
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(searchTerm, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: invalid regex pattern "${searchTerm}": ${message}`;
  }

  const results: string[] = [];
  const visitedInodes = new Set<string>();

  async function search(dir: string): Promise<void> {
    if (results.length >= MAX_RESULTS) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — skip
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;

      const fullPath = path.join(dir, entry.name);

      // Skip symlinks to prevent cycles
      if (entry.isSymbolicLink()) {
        continue;
      }

      // Skip common non-useful directories
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;

        // Track inode to detect hardlink cycles
        try {
          const stats = await fs.stat(fullPath);
          const inodeKey = `${stats.dev}:${stats.ino}`;
          if (visitedInodes.has(inodeKey)) {
            continue; // Already visited this directory
          }
          visitedInodes.add(inodeKey);
        } catch {
          // If we can't stat, skip to be safe
          continue;
        }

        await search(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Filter by extension
      if (extensions && !extensions.has(path.extname(entry.name))) continue;

      try {
        const stats = await fs.stat(fullPath);
        if (stats.size > MAX_FILE_SIZE) continue;

        const content = await fs.readFile(fullPath, 'utf8');
        if (content.includes('\0')) continue; // Binary file

        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
          if (regex.test(lines[i])) {
            let lineContent = lines[i].trim();

            // Truncate long lines
            if (lineContent.length > 500) {
              lineContent = lineContent.slice(0, 500) + '... (truncated)';
            }

            results.push(`${displayPath(fullPath)}:${i + 1}: ${lineContent}`);
          }
          regex.lastIndex = 0; // reset regex state
        }
      } catch {
        // Skip files we can't read (binary, permission issues)
      }
    }
  }

  await search(validated);

  if (results.length === 0) {
    return `No matches found for "${searchTerm}" in ${directoryPath}`;
  }

  const suffix = results.length >= MAX_RESULTS ? `\n(results truncated at ${MAX_RESULTS})` : '';
  return `Found ${results.length} match(es) for "${searchTerm}":\n${results.join('\n')}${suffix}`;
}

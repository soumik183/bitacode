/**
 * secret_scan tool — look for leaked credentials in a file, a directory or text.
 *
 * Read-only: it never writes or changes anything. Findings are redacted before
 * they reach the model, so a real key is never echoed back into the transcript.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePath } from '../utils/path-validation.js';
import { scanTextForSecrets, type SecretFinding } from '../utils/secret-scan.js';

const MAX_FILES = 250;
const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 200_000;
const MAX_FINDINGS = 40;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'coverage',
  'target', 'vendor', '.venv', 'venv', '__pycache__', '.turbo',
]);

export const secretScanTool = {
  type: 'function' as const,
  function: {
    name: 'secret_scan',
    description:
      'Scan a file, a directory, or provided text for leaked credentials (API keys, tokens, private keys). ' +
      'Read-only; results are redacted. Use before committing or when auditing a repo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to scan (defaults to the working directory).' },
        text: { type: 'string', description: 'Inline text to scan instead of a path.' },
        max_files: { type: 'number', description: 'Cap the directory walk (default 250).' },
      },
    },
  },
};

interface LocatedFinding extends SecretFinding {
  file?: string;
}

function looksBinary(text: string): boolean {
  return text.includes('\u0000');
}

async function scanFile(file: string, display: string, findings: LocatedFinding[]): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    const text = await fs.readFile(file, 'utf8');
    if (looksBinary(text)) return;
    for (const finding of scanTextForSecrets(text, MAX_FINDINGS)) {
      findings.push({ ...finding, file: display });
      if (findings.length >= MAX_FINDINGS) return;
    }
  } catch {
    // Unreadable file — skip it.
  }
}

async function walk(
  dir: string,
  root: string,
  depth: number,
  budget: { files: number; maxFiles: number },
  findings: LocatedFinding[],
): Promise<void> {
  if (depth > MAX_DEPTH || budget.files >= budget.maxFiles || findings.length >= MAX_FINDINGS) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.files >= budget.maxFiles || findings.length >= MAX_FINDINGS) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), root, depth + 1, budget, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    budget.files += 1;
    const absolute = path.join(dir, entry.name);
    await scanFile(absolute, path.relative(root, absolute).split(path.sep).join('/'), findings);
  }
}

function render(findings: LocatedFinding[], scope: string): string {
  if (findings.length === 0) return `No secrets found in ${scope}.`;
  const lines = findings.map((finding) => {
    const where = finding.file ? `${finding.file}:${finding.line}` : `line ${finding.line}`;
    return `- ${where} · ${finding.kind} · ${finding.preview}`;
  });
  return [
    `Found ${findings.length} potential secret(s) in ${scope}:`,
    ...lines,
    '',
    'Treat these as compromised if real: rotate the key, remove it from history, and use an env var instead.',
  ].join('\n');
}

export async function secretScan(args: Record<string, unknown>): Promise<string> {
  const inline = typeof args.text === 'string' ? args.text : '';
  if (inline.trim()) {
    return render(scanTextForSecrets(inline, MAX_FINDINGS), 'the provided text');
  }

  const requested = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  let validated: string;
  try {
    validated = await validatePath(requested);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  const findings: LocatedFinding[] = [];
  let stat;
  try {
    stat = await fs.stat(validated);
  } catch (err: any) {
    return `Error: cannot access '${requested}': ${err.message}`;
  }

  if (stat.isDirectory()) {
    const requestedMax = Number(args.max_files);
    const maxFiles = Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.floor(requestedMax), MAX_FILES)
      : MAX_FILES;
    await walk(validated, validated, 0, { files: 0, maxFiles }, findings);
    return render(findings, requested === '.' ? 'the working directory' : requested);
  }

  if (!stat.isFile()) return `Error: '${requested}' is not a regular file.`;
  await scanFile(validated, requested, findings);
  return render(findings, requested);
}

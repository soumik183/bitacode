/**
 * autoverify.ts — run the project's own checks and report them as a finish gate.
 *
 * Detection is intentionally conservative: only commands the repository already
 * declares (package.json scripts, Makefile targets, Cargo, pytest) are run, in
 * the order typecheck → lint → test. Anything unrecognised means "no checks",
 * never a guess.
 *
 * Off by default. `settings.autoverify` or `--autoverify` turns it on, so a
 * normal session never spawns a test suite behind the user's back.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface CheckCommand {
  name: string;
  command: string;
  source: string;
}

export interface CheckResult {
  name: string;
  command: string;
  status: 'pass' | 'fail' | 'timeout' | 'skipped';
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface DetectOptions {
  cwd: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Only run checks whose name matches one of these. */
  only?: string[];
  /** Stop after the first failure. */
  stopOnFirstFailure?: boolean;
}

const MAX_OUTPUT = 4_000;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Pick the package manager the repository actually uses. */
async function detectRunner(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(cwd, 'bun.lockb')) || await exists(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

const SCRIPT_PRIORITY: Array<{ name: string; matches: RegExp }> = [
  { name: 'typecheck', matches: /^(typecheck|type-check|tsc|check-types)$/i },
  { name: 'lint', matches: /^(lint|eslint|biome)$/i },
  { name: 'test', matches: /^(test|tests|test:unit)$/i },
];

/** Detect the checks this repository declares. Never throws. */
export async function detectChecks(options: DetectOptions): Promise<CheckCommand[]> {
  const cwd = path.resolve(options.cwd);
  const checks: CheckCommand[] = [];
  const pkg = await readJson(path.join(cwd, 'package.json'));

  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const scripts = pkg.scripts as Record<string, unknown>;
    const runner = await detectRunner(cwd);
    const used = new Set<string>();
    for (const priority of SCRIPT_PRIORITY) {
      const scriptName = Object.keys(scripts).find(
        (name) => priority.matches.test(name) && typeof scripts[name] === 'string' && !used.has(name),
      );
      if (!scriptName) continue;
      used.add(scriptName);
      checks.push({
        name: priority.name,
        command: `${runner} run ${scriptName}`,
        source: 'package.json',
      });
    }
  }

  if (await exists(path.join(cwd, 'Cargo.toml'))) {
    checks.push({ name: 'typecheck', command: 'cargo check --message-format=short', source: 'Cargo.toml' });
    checks.push({ name: 'test', command: 'cargo test --quiet', source: 'Cargo.toml' });
  }

  if (await exists(path.join(cwd, 'Makefile'))) {
    try {
      const makefile = await fs.readFile(path.join(cwd, 'Makefile'), 'utf8');
      for (const target of ['check', 'test']) {
        if (new RegExp(`^${target}:`, 'm').test(makefile)) {
          checks.push({ name: target === 'check' ? 'typecheck' : 'test', command: `make ${target}`, source: 'Makefile' });
        }
      }
    } catch {
      // ignore
    }
  }

  if (checks.length === 0 && await exists(path.join(cwd, 'pyproject.toml'))) {
    checks.push({ name: 'test', command: 'python -m pytest -q', source: 'pyproject.toml' });
  }

  // De-duplicate by name, keeping the first (highest priority) entry.
  const seen = new Set<string>();
  return checks.filter((check) => (seen.has(check.name) ? false : (seen.add(check.name), true)));
}

function runOne(check: CheckCommand, cwd: string, timeoutMs: number): Promise<CheckResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: unknown): string =>
      (current + String(chunk)).slice(-MAX_OUTPUT);

    let child;
    try {
      child = spawn(check.command, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      resolve({
        name: check.name,
        command: check.command,
        status: 'fail',
        exitCode: null,
        output: String(err instanceof Error ? err.message : err),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    child.stdout?.on('data', (chunk: unknown) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: unknown) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        name: check.name,
        command: check.command,
        status: 'timeout',
        exitCode: null,
        output: (stdout + stderr).slice(-MAX_OUTPUT),
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err: Error) => {
      finish({
        name: check.name,
        command: check.command,
        status: 'fail',
        exitCode: null,
        output: err.message,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code: number | null) => {
      finish({
        name: check.name,
        command: check.command,
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code,
        output: (stdout + stderr).slice(-MAX_OUTPUT),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Run the detected checks in priority order. */
export async function runChecks(checks: readonly CheckCommand[], options: RunOptions): Promise<CheckResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const selected = options.only && options.only.length > 0
    ? checks.filter((check) => options.only!.includes(check.name))
    : checks;

  const results: CheckResult[] = [];
  for (const check of selected) {
    const result = await runOne(check, options.cwd, timeoutMs);
    results.push(result);
    if (result.status !== 'pass' && options.stopOnFirstFailure) break;
  }
  return results;
}

export interface VerifyReport {
  ok: boolean;
  results: CheckResult[];
  text: string;
}

/** One compact card for the transcript. */
export function renderCheckReport(results: readonly CheckResult[], checks: readonly CheckCommand[] = []): string {
  if (results.length === 0) {
    return checks.length === 0 ? 'No project checks detected.' : 'No checks were run.';
  }
  const lines = results.map((result) => {
    const icon = result.status === 'pass' ? 'ok  ' : result.status === 'timeout' ? 'timeout' : 'FAIL';
    return `${icon}  ${result.name.padEnd(9)} ${result.command} (${(result.durationMs / 1000).toFixed(1)}s)`;
  });
  const failed = results.filter((result) => result.status !== 'pass');
  if (failed.length === 0) return ['Project checks passed:', ...lines].join('\n');

  const detail = failed
    .map((result) => {
      const body = result.output.trim().split('\n').slice(-25).join('\n');
      return `--- ${result.name}: ${result.command} ---\n${body}`;
    })
    .join('\n');
  return ['Project checks failed:', ...lines, '', detail].join('\n');
}

/** A single follow-up message the loop can hand back to the model. */
export function buildFixPrompt(results: readonly CheckResult[]): string {
  const failed = results.filter((result) => result.status !== 'pass');
  if (failed.length === 0) return '';
  const detail = failed
    .map((result) => `### ${result.name} (${result.command}, exit ${result.exitCode ?? 'n/a'})\n${result.output.trim().slice(-2_000)}`)
    .join('\n\n');
  return [
    'The project checks failed after your changes. Fix the failures, then stop.',
    '',
    detail,
  ].join('\n');
}

/** True when every result passed. */
export function reportPassed(results: readonly CheckResult[]): boolean {
  return results.length > 0 && results.every((result) => result.status === 'pass');
}

/**
 * Environment handling for spawned MCP stdio servers.
 *
 * Security: a stdio server must never inherit the full `process.env`, which
 * contains provider API keys and other credentials. Only an explicit
 * allowlist, a small OS baseline, and per-server explicit values are passed
 * through. Every helper here is defensive and never throws on bad input.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_HEADER = /authorization|token|key|secret|cookie/i;
const REDACTED = '***';

/**
 * Minimal variables needed for a spawned process to work at all. These are
 * read from `process.env` one by one — `process.env` is never spread.
 */
function baselineNames(): string[] {
  const names = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL'];
  if (process.platform === 'win32') names.push('SystemRoot');
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract valid environment variable names from an allowlist.
 *
 * Accepts an array of names or an object whose keys are names (as used by
 * MCP server `env` maps). Values in the object form are intentionally
 * ignored: credentials must be supplied explicitly via `buildMcpEnv.extra`.
 * Invalid, non-string and duplicate entries are skipped silently.
 */
export function parseEnvAllowlist(value: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown): void => {
    if (typeof candidate !== 'string' || !ENV_NAME.test(candidate) || seen.has(candidate)) return;
    seen.add(candidate);
    names.push(candidate);
  };

  try {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) add(key);
    }
  } catch {
    // Hostile proxies / getters: return whatever was collected so far.
  }
  return names;
}

export interface BuildMcpEnvOptions {
  /** Allowlist: string[] of names, or a record whose keys are names. */
  allowed?: unknown;
  /** Explicit per-server values; these take precedence over process.env. */
  extra?: Record<string, string>;
  /**
   * Baseline overrides / test injection. Only valid names with string values
   * are used. Supplying it does not disable the standard baseline names.
   */
  baseline?: Record<string, string>;
}

/**
 * Build the environment for a child MCP server process.
 *
 * Precedence (last wins): minimal baseline from `process.env`, caller-supplied
 * `baseline`, allowlisted values read from `process.env`, then `extra`.
 * `process.env` is never spread, so unlisted provider keys cannot leak.
 */
export function buildMcpEnv(options: BuildMcpEnvOptions = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};

  try {
    const source = process.env;
    for (const name of baselineNames()) {
      const value = source[name];
      if (typeof value === 'string') env[name] = value;
    }
    if (typeof source.NODE_PATH === 'string') env.NODE_PATH = source.NODE_PATH;

    if (isRecord(options.baseline)) {
      for (const [name, value] of Object.entries(options.baseline)) {
        if (ENV_NAME.test(name) && typeof value === 'string') env[name] = value;
      }
    }

    for (const name of parseEnvAllowlist(options.allowed)) {
      const value = source[name];
      if (typeof value === 'string') env[name] = value;
    }

    if (isRecord(options.extra)) {
      for (const [name, value] of Object.entries(options.extra)) {
        if (ENV_NAME.test(name) && typeof value === 'string') env[name] = value;
      }
    }
  } catch {
    // Never throw; return the safest partial result collected so far.
  }

  return env as NodeJS.ProcessEnv;
}

/**
 * Copy headers, masking values of authorization/token/key/secret/cookie
 * fields (case-insensitive). Bad entries are skipped; the input is unchanged.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!isRecord(headers)) return result;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || name === '') continue;
      result[name] = SENSITIVE_HEADER.test(name) ? REDACTED : value;
    }
  } catch {
    // Best effort only.
  }
  return result;
}

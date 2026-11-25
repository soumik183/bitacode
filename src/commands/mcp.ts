/**
 * `bitacode mcp` subcommand — manage MCP servers in the project config.
 *
 * Reads and writes `<cwd>/.bitacode/bitacode.jsonc` with jsonc-parser so
 * comments and surrounding formatting survive edits. A malformed config is
 * reported and never overwritten. No MCP server process is ever spawned
 * here: `test` only validates config shape and reports env *names*.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { buildMcpEnv, parseEnvAllowlist, redactHeaders } from '../utils/mcp-env.js';

export interface McpCommandIO {
  out?: (s: string) => void;
  err?: (s: string) => void;
  cwd?: string;
}

interface McpServerEntry {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
}

interface LoadedConfig {
  file: string;
  text: string;
  data: Record<string, unknown>;
  servers: Record<string, McpServerEntry>;
  exists: boolean;
}

type LoadResult =
  | { ok: true; value: LoadedConfig }
  | { ok: false; message: string };

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USAGE = 'Usage: bitacode mcp <list|add <name> <command> [args...]|remove <name>|test <name>|show <name>>';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Names are used as object keys and must never escape the config directory. */
function isValidServerName(name: unknown): name is string {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

function serverType(entry: McpServerEntry): string {
  return typeof entry.type === 'string' ? entry.type : 'unknown';
}

function envNames(value: unknown): string[] {
  return parseEnvAllowlist(value);
}

function formatNames(names: string[]): string {
  return names.length > 0 ? names.join(', ') : '(none)';
}

function configFile(cwd: string): string {
  return path.join(cwd, '.bitacode', 'bitacode.jsonc');
}

/** Parse without ever mutating the file. Missing file is a valid empty config. */
async function loadConfig(file: string): Promise<LoadResult> {
  let text: string;
  let exists = true;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      text = '';
      exists = false;
    } else {
      return { ok: false, message: `Cannot read ${file}: ${message(error)}` };
    }
  }

  const errors: ParseError[] = [];
  let data: unknown;
  try {
    data = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  } catch (error) {
    return { ok: false, message: `Cannot parse ${file}: ${message(error)}` };
  }
  if (errors.length > 0) {
    const first = errors[0];
    return {
      ok: false,
      message: `Invalid JSONC in ${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}; file left unchanged`,
    };
  }

  const root = data === undefined ? {} : data;
  if (!isRecord(root)) {
    return { ok: false, message: `Invalid config in ${file}: top level must be an object; file left unchanged` };
  }

  let servers: Record<string, McpServerEntry> = {};
  const mcp = root.mcp;
  if (mcp !== undefined) {
    if (!isRecord(mcp)) {
      return { ok: false, message: `Invalid config in ${file}: "mcp" must be an object; file left unchanged` };
    }
    const rawServers = mcp.servers;
    if (rawServers !== undefined) {
      if (!isRecord(rawServers)) {
        return { ok: false, message: `Invalid config in ${file}: "mcp.servers" must be an object; file left unchanged` };
      }
      servers = rawServers as Record<string, McpServerEntry>;
    }
  }

  return { ok: true, value: { file, text, data: root, servers, exists } };
}

/** jsonc-parser `modify` keeps comments; `undefined` removes a property. */
function editConfigText(loaded: LoadedConfig, name: string, value: unknown): string {
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' as const } };
  let text = loaded.exists && loaded.text.trim() !== '' ? loaded.text : '{}\n';

  // Make the parent objects explicit so nested edits work on a fresh config
  // as well as on a file that only has a top-level object so far.
  const mcp = loaded.data.mcp;
  if (!isRecord(mcp)) {
    text = applyEdits(text, modify(text, ['mcp'], { servers: {} }, options));
  } else if (!isRecord(mcp.servers)) {
    text = applyEdits(text, modify(text, ['mcp', 'servers'], {}, options));
  }

  return applyEdits(text, modify(text, ['mcp', 'servers', name], value, options));
}

async function writeConfig(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask; enforce it (also for an existing dir).
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Some platforms do not support chmod; the restrictive mkdir mode stands.
  }
  await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Best effort: writeFile already requested 0600.
  }
}

function listServers(file: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  return loadConfig(file).then((loaded) => {
    if (!loaded.ok) {
      err(loaded.message);
      return 1;
    }
    const rows = Object.entries(loaded.value.servers).map(([name, entry]) => ({
      NAME: name,
      TYPE: serverType(entry),
      ENABLED: entry.enabled === false ? 'false' : 'true',
      SOURCE: file,
    }));
    if (rows.length === 0) {
      out('No MCP servers configured.');
      return 0;
    }
    const headers = ['NAME', 'TYPE', 'ENABLED', 'SOURCE'] as const;
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => row[header].length)),
    );
    out(headers.map((header, index) => header.padEnd(widths[index])).join('  ').trimEnd());
    for (const row of rows) {
      out(headers.map((header, index) => row[header].padEnd(widths[index])).join('  ').trimEnd());
    }
    return 0;
  });
}

async function addServer(args: string[], file: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const name = args[1];
  const command = args[2];
  if (name === undefined || command === undefined) {
    err(`Usage: bitacode mcp add <name> <command> [args...]`);
    return 2;
  }
  if (!isValidServerName(name)) {
    err(`Invalid MCP server name: ${JSON.stringify(name)}`);
    return 1;
  }
  if (command.trim() === '') {
    err('MCP server command must not be empty.');
    return 1;
  }
  const loaded = await loadConfig(file);
  if (!loaded.ok) {
    err(loaded.message);
    return 1;
  }
  if (Object.prototype.hasOwnProperty.call(loaded.value.servers, name)) {
    err(`MCP server "${name}" already exists; remove it first.`);
    return 1;
  }

  const entry = { type: 'stdio', command, args: args.slice(3), env: [] };
  await writeConfig(file, editConfigText(loaded.value, name, entry));
  out(`Added MCP server "${name}" (stdio).`);
  return 0;
}

async function removeServer(args: string[], file: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const name = args[1];
  if (name === undefined) {
    err('Usage: bitacode mcp remove <name>');
    return 2;
  }
  if (!isValidServerName(name)) {
    err(`Invalid MCP server name: ${JSON.stringify(name)}`);
    return 1;
  }
  const loaded = await loadConfig(file);
  if (!loaded.ok) {
    err(loaded.message);
    return 1;
  }
  if (!Object.prototype.hasOwnProperty.call(loaded.value.servers, name)) {
    err(`MCP server not found: ${name}`);
    return 1;
  }

  await writeConfig(file, editConfigText(loaded.value, name, undefined));
  out(`Removed MCP server "${name}".`);
  return 0;
}

async function findServer(
  args: string[],
  file: string,
  err: (s: string) => void,
): Promise<{ name: string; entry: McpServerEntry; loaded: LoadedConfig } | number> {
  const name = args[1];
  if (name === undefined) {
    err('Usage: bitacode mcp <test|show> <name>');
    return 2;
  }
  if (!isValidServerName(name)) {
    err(`Invalid MCP server name: ${JSON.stringify(name)}`);
    return 1;
  }
  const loaded = await loadConfig(file);
  if (!loaded.ok) {
    err(loaded.message);
    return 1;
  }
  const entry = loaded.value.servers[name];
  if (entry === undefined || !isRecord(entry)) {
    err(`MCP server not found: ${name}`);
    return 1;
  }
  return { name, entry: entry as McpServerEntry, loaded: loaded.value };
}

async function showServer(args: string[], file: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const found = await findServer(args, file, err);
  if (typeof found === 'number') return found;

  const { name, entry } = found;
  const type = serverType(entry);
  out(`name: ${name}`);
  out(`type: ${type}`);
  if (type === 'stdio') {
    out(`command: ${typeof entry.command === 'string' ? entry.command : '(missing)'}`);
    const serverArgs = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
    out(`args: ${serverArgs.length > 0 ? serverArgs.join(' ') : '(none)'}`);
    out(`env: ${formatNames(envNames(entry.env))} (values hidden)`);
  } else if (type === 'http') {
    out(`url: ${typeof entry.url === 'string' ? entry.url : '(missing)'}`);
    const headers = isRecord(entry.headers)
      ? Object.entries(redactHeaders(entry.headers as Record<string, string>)).map(([key, value]) => `${key}=${value}`)
      : [];
    out(`headers: ${headers.length > 0 ? headers.join(', ') : '(none)'}`);
  }
  out(`enabled: ${entry.enabled === false ? 'false' : 'true'}`);
  out(`source: ${file}`);
  return 0;
}

/** Config-shape validation only; nothing is spawned and no env value is shown. */
async function testServer(args: string[], file: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const found = await findServer(args, file, err);
  if (typeof found === 'number') return found;

  const { name, entry } = found;
  const type = serverType(entry);
  const problems: string[] = [];
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command.trim() === '') problems.push('missing command');
    if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string'))) {
      problems.push('args must be an array of strings');
    }
    if (entry.env !== undefined && !Array.isArray(entry.env) && !isRecord(entry.env)) {
      problems.push('env must be an array or object');
    }
  } else if (type === 'http') {
    if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) problems.push('missing valid url');
    if (entry.headers !== undefined && !isRecord(entry.headers)) problems.push('headers must be an object');
  } else {
    problems.push(`unknown server type: ${type}`);
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    problems.push('enabled must be a boolean');
  }

  if (problems.length > 0) {
    out(`Server "${name}": not well-formed`);
    for (const problem of problems) err(`  ${problem}`);
    return 1;
  }

  out(`Server "${name}": well-formed`);
  const allowed = type === 'stdio' ? envNames(entry.env) : [];
  const keys = Object.keys(buildMcpEnv({ allowed })).sort();
  out(`env keys (names only): ${formatNames(keys)}`);
  return 0;
}

/**
 * Run a `bitacode mcp` subcommand.
 * Returns 0 on success, 1 on config/fs/validation errors, 2 on usage errors.
 */
export async function runMcpCommand(args: string[], io: McpCommandIO = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  try {
    const cwd = io.cwd ?? process.cwd();
    const file = configFile(cwd);
    const sub = (args[0] ?? 'list').toLowerCase();
    switch (sub) {
      case 'list':
        return await listServers(file, out, err);
      case 'add':
        return await addServer(args, file, out, err);
      case 'remove':
        return await removeServer(args, file, out, err);
      case 'show':
        return await showServer(args, file, out, err);
      case 'test':
        return await testServer(args, file, out, err);
      default:
        err(`Unknown MCP command: ${sub}`);
        err(USAGE);
        return 2;
    }
  } catch (error) {
    err(`MCP command failed: ${message(error)}`);
    return 1;
  }
}

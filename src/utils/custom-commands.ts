/**
 * custom-commands.ts — project and user slash commands written as Markdown.
 *
 * A command is a `.md` file whose name is the command and whose body is the
 * prompt. Frontmatter is optional:
 *
 *   ---
 *   description: Review the current diff
 *   argument-hint: [path]
 *   ---
 *   Review the diff for $1. Focus on correctness.
 *
 * `$1`…`$9` are positional arguments and `$ARGUMENTS` is the whole tail, so the
 * same file works as `/review src/app.ts` or `/review`.
 *
 * Project commands (`<repo>/.bitacode/commands/*.md`) only load when the project
 * is trusted: a cloned repo must not be able to inject prompts silently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** In-process handler a plugin may attach to a command. */
export type CommandHandler = (args: string[]) => string | void | Promise<string | void>;

export interface CustomCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  source: string;
  /** Plugin-provided handler; takes precedence over `body` for the invoker. */
  handler?: CommandHandler;
}

export interface CustomCommandLoadResult {
  commands: CustomCommand[];
  errors: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9][\w:-]*$/;
const MAX_BODY_CHARS = 40_000;

function userCommandsDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'bitacode', 'commands');
}

function projectCommandsDir(cwd: string): string {
  return path.join(cwd, '.bitacode', 'commands');
}

/** Parse frontmatter without a YAML dependency: `key: value` pairs only. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { meta: {}, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text.trim() };
  const header = text.slice(3, end).trim();
  const body = text.slice(text.indexOf('\n', end + 1) + 1).trim();
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }
  return { meta, body };
}

export function parseCommandFile(raw: string, file: string, nameSeed?: string): CustomCommand | { error: string } {
  const base = nameSeed ?? path.basename(file, path.extname(file));
  if (!NAME_PATTERN.test(base)) {
    return { error: `${file}: command name "${base}" must be alphanumeric with dashes` };
  }
  const { meta, body } = parseFrontmatter(raw);
  if (!body) return { error: `${file}: command body is empty` };
  if (body.length > MAX_BODY_CHARS) {
    return { error: `${file}: command body is larger than ${MAX_BODY_CHARS} characters` };
  }
  const command: CustomCommand = {
    name: base,
    description: meta.description ?? firstLine(body),
    body,
    source: file,
  };
  if (meta['argument-hint']) command.argumentHint = meta['argument-hint'];
  return command;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim().length > 0) ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 120);
}

function readDir(dir: string, errors: string[], commands: CustomCommand[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') errors.push(`${dir}: ${String(err)}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const parsed = parseCommandFile(fs.readFileSync(file, 'utf8'), file);
      if ('error' in parsed) errors.push(parsed.error);
      else commands.push(parsed);
    } catch (err) {
      errors.push(`${file}: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
}

export function loadCustomCommands(
  options: { cwd: string; trusted: boolean; userDir?: string; projectDir?: string },
  extraCommands: readonly CustomCommand[] = [],
): CustomCommandLoadResult {
  const result: CustomCommandLoadResult = { commands: [], errors: [] };
  const userDir = options.userDir ?? userCommandsDir();
  const projectDir = options.projectDir ?? projectCommandsDir(options.cwd);

  readDir(userDir, result.errors, result.commands);
  if (options.trusted) {
    readDir(projectDir, result.errors, result.commands);
  } else if (fs.existsSync(projectDir)) {
    result.errors.push(`${projectDir}: ignored because this project is not trusted (run: bitacode permissions trust)`);
  }

  // Project commands win over user commands, which win over plugin commands.
  const seen = new Map<string, CustomCommand>();
  for (const command of [...extraCommands, ...result.commands]) seen.set(command.name.toLowerCase(), command);
  result.commands = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Split arguments the way a shell would, without running anything. */
export function splitCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

/** Substitute `$1`…`$9` and `$ARGUMENTS` into the body. */
export function expandCommand(command: CustomCommand, argumentText: string): string {
  const args = splitCommandArgs(argumentText);
  let body = command.body.replace(/\$ARGUMENTS\b/g, argumentText.trim());
  body = body.replace(/\$([1-9])\b/g, (_match, index: string) => args[Number(index) - 1] ?? '');
  return body.replace(/[ \t]+$/gm, '').trim();
}

/** Palette / help listing. */
export function describeCustomCommands(commands: readonly CustomCommand[]): string[] {
  if (commands.length === 0) return ['no custom commands found'];
  return commands.map((command) => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''} — ${command.description}`);
}

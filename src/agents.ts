/**
 * Named agents — markdown-defined agent profiles for Bitacode.
 *
 * Agents are first-class, named presets: a short system prompt plus optional
 * model, tool and approval settings. Built-in agents (`build`, `plan`,
 * `general`) are always available and can be overridden by markdown files in
 * project or user configuration directories. This mirrors OpenCode v2's
 * `.opencode/agent/*.md` behaviour, adapted to Bitacode's `.bitacode` layout.
 *
 * Discovery is deliberately synchronous and total: a malformed file is
 * skipped (with a `logger.warn` and an entry in `errors`), never thrown.
 */

import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { logger } from './utils/logger.js';

/** A named agent profile, whether built-in or loaded from a markdown file. */
export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  provider?: string;
  tools?: string[];
  denyTools?: string[];
  approval?: 'manual' | 'auto' | 'yolo';
  /** `builtin` or the absolute path of the markdown file the agent came from. */
  source: string;
}

/** Result wrapper used by discovery. Success may carry per-file `errors`. */
export type AgentResult<T> =
  | { ok: true; value: T; errors?: string[] }
  | { ok: false; error: string };

type AgentOrigin = 'builtin' | 'project' | 'user';

interface DiscoveryRoot {
  dir: string;
  origin: Exclude<AgentOrigin, 'builtin'>;
}

interface DiscoveredAgent {
  agent: AgentDefinition;
  origin: AgentOrigin;
}

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_AGENT_FILES = 64;
const MAX_PROMPT_CHARS = 32 * 1024;
const VALID_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALID_APPROVALS = new Set(['manual', 'auto', 'yolo']);
// Frontmatter must start on line 1 and be closed by a `---` line. A trailing
// newline after the closing delimiter is optional (an empty prompt is valid).
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Default agent: full access, no tool restrictions. */
const BUILD_AGENT: AgentDefinition = {
  name: 'build',
  description: 'Default agent with full access to all tools.',
  prompt:
    "You are Bitacode's default coding agent. Complete the user's request using the available tools. " +
    'Inspect before editing, make precise changes, verify them, and report the result concisely.',
  source: 'builtin',
};

/** Read-only agent for investigation and implementation planning. */
const PLAN_AGENT: AgentDefinition = {
  name: 'plan',
  description: 'Read-only planning agent that investigates and proposes a concrete plan.',
  prompt:
    'You are a planning agent. Investigate the codebase using read-only tools, then return a concise, ' +
    'ordered plan with concrete files and steps. Do not modify files.',
  tools: [
    'read_file', 'read_lines', 'glob', 'search_files', 'search_docs', 'codesearch',
    'find_symbol', 'list_directory', 'diff', 'git_diff', 'webfetch', 'web_search',
    'open_url', 'plan', 'todo_read', 'todo_write',
  ],
  approval: 'manual',
  source: 'builtin',
};

/** General-purpose agent oriented towards delegated sub-agent work. */
const GENERAL_AGENT: AgentDefinition = {
  name: 'general',
  description: 'General-purpose sub-agent for delegated, self-contained tasks.',
  prompt:
    'You are a general-purpose sub-agent. Work autonomously on the single task you were given, ' +
    'use the tools you need, and return a short summary of findings and changes. Do not ask the user questions.',
  source: 'builtin',
};

/** Built-in agents are always available; file agents may override them by name. */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = Object.freeze([
  Object.freeze(BUILD_AGENT),
  Object.freeze(PLAN_AGENT),
  Object.freeze(GENERAL_AGENT),
]);

function originRank(origin: AgentOrigin): number {
  if (origin === 'builtin') return 0;
  if (origin === 'user') return 1;
  return 2;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

/** YAML accepts a comma/space separated string or an array of strings. */
function parseToolList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const raw: unknown = typeof value === 'string' ? value.split(/[,\s]+/) : value;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be a string or an array of strings.`);
  }
  return (raw as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function parseApproval(value: unknown): AgentDefinition['approval'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !VALID_APPROVALS.has(value)) {
    throw new Error('approval must be one of: manual, auto, yolo.');
  }
  return value as AgentDefinition['approval'];
}

/** Parse one markdown agent file. Throws on any invalid field or shape. */
function parseAgentFile(raw: string, source: string): AgentDefinition {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    throw new Error('File must begin with YAML frontmatter delimited by --- lines.');
  }

  const document: unknown = YAML.parse(match[1]);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Frontmatter must parse to an object.');
  }
  const frontmatter = document as Record<string, unknown>;

  const name = requireString(frontmatter.name, 'name');
  if (!VALID_AGENT_NAME.test(name)) {
    throw new Error(`Invalid agent name "${name}"; expected a slug of 1-64 characters.`);
  }
  const description = requireString(frontmatter.description, 'description');
  const prompt = match[2].trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt exceeds the ${MAX_PROMPT_CHARS} character limit.`);
  }

  const model = optionalString(frontmatter.model, 'model');
  const provider = optionalString(frontmatter.provider, 'provider');
  const tools = parseToolList(frontmatter.tools, 'tools');
  const denyTools = parseToolList(frontmatter.denyTools, 'denyTools');
  const approval = parseApproval(frontmatter.approval);

  return {
    name,
    description,
    prompt,
    source,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(tools === undefined ? {} : { tools }),
    ...(denyTools === undefined ? {} : { denyTools }),
    ...(approval === undefined ? {} : { approval }),
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function getDiscoveryRoots(options: { cwd?: string; home?: string }): DiscoveryRoot[] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  return [
    { dir: path.join(cwd, '.bitacode', 'agents'), origin: 'project' },
    { dir: path.join(cwd, '.agents', 'agents'), origin: 'project' },
    { dir: path.join(home, '.config', 'bitacode', 'agents'), origin: 'user' },
    { dir: path.join(home, '.bitacode', 'agents'), origin: 'user' },
  ];
}

/** Discover agents from project and user roots, with built-ins as a base. */
export function discoverAgents(options: { cwd?: string; home?: string } = {}): AgentResult<AgentDefinition[]> {
  const errors: string[] = [];

  try {
    const merged = new Map<string, DiscoveredAgent>();
    for (const builtin of BUILTIN_AGENTS) {
      merged.set(builtin.name, { agent: builtin, origin: 'builtin' });
    }

    let filesSeen = 0;
    let capped = false;

    rootLoop: for (const root of getDiscoveryRoots(options)) {
      let realRoot: string;
      let entries: Dirent[];
      try {
        realRoot = realpathSync(root.dir);
        entries = readdirSync(root.dir, { withFileTypes: true });
      } catch {
        // Missing or unreadable roots are normal; nothing to discover here.
        continue;
      }

      for (const entry of entries) {
        // Only regular markdown files; dotfiles are never agent definitions.
        if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;

        if (filesSeen >= MAX_AGENT_FILES) {
          capped = true;
          break rootLoop;
        }

        const filePath = path.join(root.dir, entry.name);
        try {
          const info = lstatSync(filePath);
          if (info.isSymbolicLink()) {
            const target = realpathSync(filePath);
            if (!isInside(realRoot, target)) {
              throw new Error(`symlink escapes agent root ${realRoot}`);
            }
            if (!statSync(target).isFile()) continue;
          } else if (!info.isFile()) {
            continue;
          }
          const size = statSync(filePath).size;
          if (size > MAX_AGENT_FILE_BYTES) {
            throw new Error(`file is ${size} bytes (limit ${MAX_AGENT_FILE_BYTES})`);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const message = `Skipping agent file ${filePath}: ${reason}`;
          logger.warn(message);
          errors.push(message);
          continue;
        }

        filesSeen++;
        let agent: AgentDefinition;
        try {
          agent = parseAgentFile(readFileSync(filePath, 'utf8'), filePath);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const message = `Skipping invalid agent at ${filePath}: ${reason}`;
          logger.warn(message);
          errors.push(message);
          continue;
        }

        const existing = merged.get(agent.name);
        if (existing && originRank(existing.origin) >= originRank(root.origin)) {
          // Equal-priority collisions keep the first root; project roots win
          // over user roots, and any file agent wins over a built-in.
          logger.warn(`Agent "${agent.name}" from ${filePath} was ignored: a higher-priority agent with that name already exists.`, {
            ignored: filePath,
          });
          continue;
        }
        if (existing) {
          logger.warn(`Agent "${agent.name}" overridden by ${filePath}.`, {
            previous: existing.agent.source,
          });
        }
        merged.set(agent.name, { agent, origin: root.origin });
      }
    }

    if (capped) {
      const message = `Agent discovery stopped after the ${MAX_AGENT_FILES} file limit was reached.`;
      logger.warn(message);
      errors.push(message);
    }

    return { ok: true, value: Array.from(merged.values(), (entry) => entry.agent), errors };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Agent discovery failed', { error: reason });
    return { ok: false, error: reason };
  }
}

/** Look up an agent by exact name. Without a list, uses discovered agents. */
export function getAgent(name: string, agents?: AgentDefinition[]): AgentDefinition | undefined {
  let pool = agents;
  if (pool === undefined) {
    const discovered = discoverAgents();
    pool = discovered.ok ? discovered.value : [...BUILTIN_AGENTS];
  }
  if (typeof name !== 'string') return undefined;
  const wanted = name.trim();
  if (!wanted) return undefined;
  return pool.find((agent) => agent.name === wanted);
}

/** Select an agent by name, falling back to `build` for absent/unknown names. */
export function resolveAgentSelection(requested: string | undefined, agents: AgentDefinition[]): AgentDefinition {
  const fallback = getAgent('build', agents) ?? BUILTIN_AGENTS[0];
  if (typeof requested !== 'string' || requested.trim() === '') return fallback;
  return getAgent(requested, agents) ?? fallback;
}

/** Compact one-line-per-agent Markdown catalog (metadata only, no prompts). */
export function renderAgentCatalog(agents: AgentDefinition[]): string {
  if (!Array.isArray(agents) || agents.length === 0) return '';
  return agents
    .map((agent) => {
      const description = agent.description.replace(/\s+/g, ' ').trim();
      const source = String(agent.source ?? '').replace(/\s+/g, ' ').trim();
      return `- ${agent.name}: ${description} [source: ${source}]`;
    })
    .join('\n');
}

/**
 * Apply an agent's optional allowlist and denylist to a set of tool names.
 * Input order is preserved; a non-empty input never produces an empty output.
 */
export function applyAgentTools(agent: AgentDefinition, tools: string[]): string[] {
  if (!Array.isArray(tools)) return [];
  const input = tools.filter((tool): tool is string => typeof tool === 'string');
  if (input.length === 0) return [];

  const normalize = (values?: string[]): Set<string> =>
    new Set((values ?? []).filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean));

  const allow = agent.tools === undefined ? null : normalize(agent.tools);
  const deny = normalize(agent.denyTools);
  let result = input.filter((tool) => allow === null || allow.has(tool.trim()));
  result = result.filter((tool) => !deny.has(tool.trim()));

  // A tool budget of zero would leave the agent unable to act; keep the first
  // requested tool as a safe fallback rather than returning an empty list.
  return result.length > 0 ? result : [input[0]];
}

/**
 * permission-rules.ts — declarative allow/ask/deny rules for tool calls.
 *
 * Rules are the middle layer between the coarse approval mode and the command
 * gate:
 *
 *   deny  >  ask  >  allow  >  approval mode
 *
 * A rule is `tool` or `tool(argument-pattern)`:
 *
 *   bash(git status *)        command glob, `*` spans spaces
 *   bash(git * --dry-run)     any position
 *   write_file(src/**)        path glob, `**` crosses directories
 *   read_file(*.md)           relative to the project root
 *   webfetch(domain:docs.rs)  host check, `domain:` prefix
 *   delete                    every call to that tool
 *
 * Matching is deliberately dumb and predictable: no regexes from user input, no
 * ordering games. Anything that fails to compile is reported in `errors` and is
 * kept as a literal matcher, so a typo can never silently widen a deny rule.
 */

import path from 'node:path';
import { scanShell } from './shell-scan.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type RuleArgKind = 'command' | 'path' | 'domain' | 'any';

export interface PermissionRule {
  /** Original text, shown by `bitacode permissions show`. */
  raw: string;
  /** Tool-name glob, lower-cased. */
  toolPattern: string;
  /** Argument glob, absent when the rule targets the whole tool. */
  argumentPattern?: string;
  argKind: RuleArgKind;
  /** Pattern compiled for the specific argument kind. */
  matcher?: RegExp;
  toolMatcher: RegExp;
  /** Set when the rule had to be degraded to a literal matcher. */
  error?: string;
}

export interface PermissionRuleSet {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
  errors: string[];
}

export interface PermissionCall {
  tool: string;
  args?: Record<string, unknown>;
  cwd?: string;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  /** Raw text of the rule that decided it, when any. */
  rule?: string;
  /** Which bucket matched. */
  source?: 'deny' | 'ask' | 'allow';
  /** Set when the decision came from a degraded or invalid rule. */
  warning?: string;
}

const SHELL_CONTROL = /[;&|<>$`\n]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Command globs let `*` span spaces, because arguments contain them. */
function commandGlobToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => escapeRegExp(part).replace(/\s+/g, '\\s+'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** Path globs treat `**` as "anything" and a single `*` as "no separator". */
function pathGlobToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i++;
      continue;
    }
    if (char === '*') {
      out += '[^/\\\\]*';
      continue;
    }
    if (char === '?') {
      out += '[^/\\\\]';
      continue;
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`, 'i');
}

function toolGlobToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');
}

/** Split `tool(arg)` into its parts, tolerating nested parentheses in the arg. */
export function splitRule(raw: string): { tool: string; argument?: RuleArgKind extends never ? never : string } | null {
  const text = raw.trim();
  if (!text) return null;
  const open = text.indexOf('(');
  if (open === -1) return { tool: text.toLowerCase() };
  if (!text.endsWith(')')) return null;
  const tool = text.slice(0, open).trim().toLowerCase();
  const argument = text.slice(open + 1, -1).trim();
  if (!tool) return null;
  return { tool, argument };
}

function detectArgKind(tool: string, argument: string): RuleArgKind {
  if (argument.toLowerCase().startsWith('domain:')) return 'domain';
  if (tool === 'bash' || tool === 'shell' || tool === 'terminal' || tool === 'run' || tool === 'start_process' || tool === 'background') {
    return 'command';
  }
  if (tool === 'webfetch' || tool === 'fetch_url' || tool === 'open_url' || tool === 'web_search' || tool === 'websearch') {
    return 'domain';
  }
  if (argument.includes('/') || argument.includes('*') || /\.[a-z0-9]{1,8}$/i.test(argument)) return 'path';
  return 'any';
}

/** Parse one rule. Returns a degraded rule (with `error`) instead of throwing. */
export function parseRule(raw: string): PermissionRule | { error: string } {
  const parts = splitRule(raw);
  if (!parts) {
    return { error: `invalid permission rule "${raw}" (expected tool or tool(pattern))` };
  }
  const rule: PermissionRule = {
    raw: raw.trim(),
    toolPattern: parts.tool,
    toolMatcher: toolGlobToRegExp(parts.tool),
    argKind: 'any',
  };
  if (parts.argument === undefined || parts.argument === '') {
    return rule;
  }

  const argKind = detectArgKind(parts.tool, parts.argument);
  const pattern = argKind === 'domain' && /^domain:/i.test(parts.argument)
    ? parts.argument.slice('domain:'.length).trim()
    : parts.argument;
  rule.argKind = argKind;
  rule.argumentPattern = pattern;

  try {
    if (argKind === 'command') rule.matcher = commandGlobToRegExp(pattern);
    else if (argKind === 'path') rule.matcher = pathGlobToRegExp(pattern);
    else if (argKind === 'domain') {
      const body = pattern.split('*').map(escapeRegExp).join('[^\\s/]*');
      rule.matcher = new RegExp(`^(?:[a-z]+://)?(?:[^/@]*@)?(?:${body})(?::\\d+)?(?:/|$)`, 'i');
    } else rule.matcher = commandGlobToRegExp(pattern);
  } catch (err) {
    rule.matcher = new RegExp(`^${escapeRegExp(pattern)}$`, 'i');
    rule.error = `rule "${raw.trim()}" did not compile (${String(err instanceof Error ? err.message : err)}); matched literally`;
  }
  return rule;
}

function toList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof input === 'string') {
    return input.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function isRuleError(value: PermissionRule | { error: string }): value is { error: string } {
  return !('toolMatcher' in value);
}

function parseBucket(raw: unknown, errors: string[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const entry of toList(raw)) {
    const parsed = parseRule(entry);
    if (isRuleError(parsed)) {
      errors.push(parsed.error);
      continue;
    }
    if (parsed.error) errors.push(parsed.error);
    rules.push(parsed);
  }
  return rules;
}

export function parseRuleSet(input: {
  allow?: unknown;
  ask?: unknown;
  deny?: unknown;
} | undefined | null): PermissionRuleSet {
  const errors: string[] = [];
  const set: PermissionRuleSet = {
    allow: parseBucket(input?.allow, errors),
    ask: parseBucket(input?.ask, errors),
    deny: parseBucket(input?.deny, errors),
    errors,
  };
  return set;
}

export function mergeRuleSets(...sets: PermissionRuleSet[]): PermissionRuleSet {
  const merged: PermissionRuleSet = { allow: [], ask: [], deny: [], errors: [] };
  for (const set of sets) {
    merged.allow.push(...set.allow);
    merged.ask.push(...set.ask);
    merged.deny.push(...set.deny);
    merged.errors.push(...set.errors);
  }
  return merged;
}

export function isEmptyRuleSet(set: PermissionRuleSet): boolean {
  return set.allow.length === 0 && set.ask.length === 0 && set.deny.length === 0;
}

/** Collect the strings a rule pattern may be compared against. */
function argumentCandidates(call: PermissionCall): { commands: string[]; paths: string[]; domains: string[]; any: string[] } {
  const args = call.args ?? {};
  const commands: string[] = [];
  const paths: string[] = [];
  const domains: string[] = [];
  const any: string[] = [];

  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text) return;
    any.push(text);
  };

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      push(value);
      if (key === 'command' || key === 'cmd' || key === 'script') commands.push(value.trim());
      if (/path|file|directory|dir|source|destination|cwd|root/i.test(key)) paths.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          push(item);
          if (/path|file/i.test(key)) paths.push(item.trim());
        }
      }
    }
  }

  for (const candidate of any) {
    if (/^https?:\/\//i.test(candidate)) {
      try {
        domains.push(new URL(candidate).host);
        domains.push(candidate);
      } catch {
        domains.push(candidate);
      }
    }
  }

  // A shell command's own arguments are paths often enough to be worth matching.
  for (const command of commands) {
    for (const token of command.split(/\s+/)) {
      if (token.includes('/') || token.startsWith('.')) paths.push(token);
    }
  }

  return { commands, paths, domains, any };
}

function ruleMatches(rule: PermissionRule, call: PermissionCall, candidates: ReturnType<typeof argumentCandidates>): boolean {
  if (!rule.toolMatcher.test(call.tool)) return false;
  if (!rule.matcher) return true;
  const matcher = rule.matcher;

  switch (rule.argKind) {
    case 'command':
      return candidates.commands.some((value) => matcher.test(value));
    case 'domain':
      return candidates.domains.some((value) => matcher.test(value));
    case 'path': {
      const root = call.cwd ?? process.cwd();
      for (const value of candidates.paths) {
        if (matcher.test(value)) return true;
        try {
          if (path.isAbsolute(value) && matcher.test(value)) return true;
          const relative = path.relative(root, path.resolve(root, value)).split(path.sep).join('/');
          if (relative && matcher.test(relative)) return true;
        } catch {
          // Unparsable path simply does not match.
        }
      }
      return false;
    }
    default:
      return candidates.any.some((value) => matcher.test(value));
  }
}

/**
 * Evaluate a call against a rule set.
 *
 * Order of precedence is deny > ask > allow, independent of the order the rules
 * were declared in. A degraded rule reports its warning but still applies.
 */
export function evaluatePermission(set: PermissionRuleSet | undefined, call: PermissionCall): PermissionEvaluation {
  if (!set) return { decision: 'ask' };
  if (!call.tool || !call.tool.trim()) {
    return { decision: 'deny', source: 'deny', rule: 'invalid-call', warning: 'tool name is empty' };
  }
  const candidates = argumentCandidates(call);

  for (const rule of set.deny) {
    if (ruleMatches(rule, call, candidates)) {
      return { decision: 'deny', source: 'deny', rule: rule.raw, warning: rule.error };
    }
  }
  for (const rule of set.ask) {
    if (ruleMatches(rule, call, candidates)) {
      return { decision: 'ask', source: 'ask', rule: rule.raw, warning: rule.error };
    }
  }
  for (const rule of set.allow) {
    if (ruleMatches(rule, call, candidates)) {
      // A text match on `git status` must never silently approve
      // `git status && rm -rf .` or `git status $(payload)`. Shell structure is
      // checked before an allow rule can grant access.
      for (const command of candidates.commands) {
        const scan = scanShell(command);
        if (scan.risk === 'high' || scan.hasSubstitution) {
          return {
            decision: 'ask',
            source: 'ask',
            rule: rule.raw,
            warning: `shell allow-rule blocked by command structure: ${scan.reasons.join('; ') || 'high risk'}`,
          };
        }
      }
      return { decision: 'allow', source: 'allow', rule: rule.raw, warning: rule.error };
    }
  }
  return { decision: 'ask' };
}

/** Human-readable listing for `bitacode permissions show`. */
export function describeRuleSet(set: PermissionRuleSet): string[] {
  const lines: string[] = [];
  const bucket = (label: string, rules: PermissionRule[]) => {
    if (rules.length === 0) return;
    lines.push(`${label}:`);
    for (const rule of rules) lines.push(`  ${rule.raw}${rule.error ? '  (degraded)' : ''}`);
  };
  bucket('deny', set.deny);
  bucket('ask', set.ask);
  bucket('allow', set.allow);
  if (set.errors.length > 0) {
    lines.push('errors:');
    for (const error of set.errors) lines.push(`  ${error}`);
  }
  if (lines.length === 0) lines.push('no permission rules configured');
  return lines;
}

/** True when a rule target looks like a shell command that runs several things. */
export function ruleLooksChained(raw: string): boolean {
  const parts = splitRule(raw);
  if (!parts?.argument) return false;
  return SHELL_CONTROL.test(parts.argument.replace(/\*/g, ''));
}

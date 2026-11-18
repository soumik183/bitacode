/**
 * Tiny, dependency-free syntax highlighter for the terminal code cards.
 *
 * Pure by design: it returns token arrays (one per source line) and never
 * touches Ink, so it is cheap to test and safe to call from any surface.
 * Colours are optional — uncoloured tokens inherit the surrounding <Text>,
 * which is how a diff line keeps its green/red tint while keywords and
 * strings still get their own colour.
 */

import { theme } from '../theme.js';

export interface HighlightToken {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

export type HighlightLanguage =
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'json'
  | 'bash'
  | 'python'
  | 'markdown'
  | 'diff'
  | 'text';

export interface HighlightOptions {
  /** Input longer than this is sliced before tokenizing (keeps previews cheap). */
  maxChars?: number;
}

/** Above this many characters we stop tokenizing altogether. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const COLOR = {
  comment: theme.dim,
  string: theme.success,
  key: '#9cdcfe',
  keyword: theme.accent,
  literal: theme.info,
  number: '#b5cea8',
  fn: '#dcdcaa',
  heading: theme.info,
  add: theme.success,
  remove: theme.error,
  hunk: theme.info,
} as const;

interface Rule {
  name: string;
  source: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  /** Recognise but pass through untouched (e.g. ANSI escape sequences). */
  plain?: boolean;
}

interface Tokenizer {
  regex: RegExp;
  names: string[];
  styles: Map<string, Rule>;
}

// ─── Reusable regex fragments ───
const ANSI: Rule = { name: 'ansi', source: '\\x1b\\[[0-9;?]*[ -/]*[@-~]', plain: true };
const DOUBLE = '"(?:\\\\.|[^"\\\\])*"';
const SINGLE = "'(?:\\\\.|[^'\\\\])*'";
const BACKTICK = '`(?:\\\\.|[^`\\\\])*`';
const TRIPLE = "'''[\\s\\S]*?'''|\"\"\"[\\s\\S]*?\"\"\"";
const LINE_COMMENT = '//[^\\n]*';
const HASH_COMMENT = '#[^\\n]*';
const BLOCK_COMMENT = '\\/\\*[\\s\\S]*?\\*\\/';
const NUMBER = '\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';
const CALL = '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()';
const JSON_KEY = `${DOUBLE}(?=\\s*:)`;

const JS_KEYWORDS = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'default', 'new', 'class', 'extends',
  'super', 'this', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'yield',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'interface', 'type',
  'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'static',
  'abstract', 'declare', 'export', 'import', 'from', 'as', 'namespace', 'module',
  'satisfies', 'keyof', 'infer', 'get', 'set', 'is',
];
const JS_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];
const PY_KEYWORDS = [
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not',
  'and', 'or', 'is', 'import', 'from', 'as', 'try', 'except', 'finally', 'with',
  'lambda', 'pass', 'break', 'continue', 'yield', 'global', 'nonlocal', 'assert',
  'del', 'raise', 'async', 'await',
];
const PY_LITERALS = ['True', 'False', 'None'];
const SH_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'select', 'time', 'in', 'export', 'local',
  'readonly', 'declare', 'source', 'return', 'break', 'continue', 'exit', 'set',
  'unset', 'trap', 'shift', 'eval', 'exec', 'alias', 'echo', 'cd', 'pwd',
];
const SH_LITERALS = ['true', 'false'];

function words(list: string[]): string {
  return `\\b(?:${list.join('|')})\\b`;
}

function rulesFor(language: Exclude<HighlightLanguage, 'text'>): Rule[] {
  switch (language) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return [
        ANSI,
        { name: 'comment', source: `${LINE_COMMENT}|${BLOCK_COMMENT}`, color: COLOR.comment, dim: true },
        { name: 'string', source: `${DOUBLE}|${SINGLE}|${BACKTICK}`, color: COLOR.string },
        { name: 'keyword', source: words(JS_KEYWORDS), color: COLOR.keyword, bold: true },
        { name: 'literal', source: words(JS_LITERALS), color: COLOR.literal },
        { name: 'number', source: NUMBER, color: COLOR.number },
        { name: 'call', source: CALL, color: COLOR.fn },
      ];
    case 'json':
      return [
        ANSI,
        { name: 'key', source: JSON_KEY, color: COLOR.key },
        { name: 'literal', source: words(['true', 'false', 'null']), color: COLOR.literal },
        { name: 'number', source: NUMBER, color: COLOR.number },
        { name: 'string', source: DOUBLE, color: COLOR.string },
      ];
    case 'bash':
      return [
        ANSI,
        { name: 'comment', source: HASH_COMMENT, color: COLOR.comment, dim: true },
        { name: 'string', source: `${DOUBLE}|${SINGLE}`, color: COLOR.string },
        { name: 'keyword', source: words(SH_KEYWORDS), color: COLOR.keyword, bold: true },
        { name: 'literal', source: words(SH_LITERALS), color: COLOR.literal },
        { name: 'number', source: NUMBER, color: COLOR.number },
        { name: 'call', source: CALL, color: COLOR.fn },
      ];
    case 'python':
      return [
        ANSI,
        { name: 'comment', source: HASH_COMMENT, color: COLOR.comment, dim: true },
        { name: 'string', source: `${TRIPLE}|${DOUBLE}|${SINGLE}`, color: COLOR.string },
        { name: 'keyword', source: words(PY_KEYWORDS), color: COLOR.keyword, bold: true },
        { name: 'literal', source: words(PY_LITERALS), color: COLOR.literal },
        { name: 'number', source: NUMBER, color: COLOR.number },
        { name: 'call', source: CALL, color: COLOR.fn },
      ];
    case 'markdown':
      return [
        ANSI,
        { name: 'fence', source: '^[ \\t]*```[^\\n]*', color: COLOR.comment, dim: true },
        { name: 'heading', source: '^#{1,6}[ \\t]+[^\\n]*', color: COLOR.heading, bold: true },
        { name: 'bold', source: '\\*\\*[^*\\n]+\\*\\*', bold: true },
        { name: 'link', source: '\\[[^\\]\\n]+\\]\\([^)\\n]+\\)', color: COLOR.key },
        { name: 'code', source: BACKTICK, color: COLOR.string },
      ];
    case 'diff':
      return [
        ANSI,
        { name: 'hunk', source: '^@@[^\\n]*', color: COLOR.hunk },
        { name: 'add', source: '^\\+[^\\n]*', color: COLOR.add },
        { name: 'remove', source: '^-[^\\n]*', color: COLOR.remove },
      ];
  }
}

const CACHE = new Map<Exclude<HighlightLanguage, 'text'>, Tokenizer>();

function tokenizer(language: Exclude<HighlightLanguage, 'text'>): Tokenizer {
  let cached = CACHE.get(language);
  if (!cached) {
    const rules = rulesFor(language);
    cached = {
      regex: new RegExp(rules.map((rule) => `(?<${rule.name}>${rule.source})`).join('|'), 'gm'),
      names: rules.map((rule) => rule.name),
      styles: new Map(rules.map((rule) => [rule.name, rule])),
    };
    CACHE.set(language, cached);
  }
  return cached;
}

const EXTENSIONS: Record<string, HighlightLanguage> = {
  ts: 'ts', mts: 'ts', cts: 'ts',
  tsx: 'tsx',
  js: 'js', mjs: 'js', cjs: 'js',
  jsx: 'jsx',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  py: 'python', pyw: 'python',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  diff: 'diff', patch: 'diff',
};

const HINTS: Record<string, HighlightLanguage> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  javascript: 'js', js: 'js', jsx: 'jsx',
  json: 'json', jsonc: 'json',
  shell: 'bash', bash: 'bash', sh: 'bash', zsh: 'bash', fish: 'bash',
  python: 'python', py: 'python',
  markdown: 'markdown', md: 'markdown',
  diff: 'diff', patch: 'diff',
  text: 'text', plain: 'text', none: 'text',
};

function normalizeLanguage(language: HighlightLanguage | string | undefined): HighlightLanguage {
  if (!language) return 'text';
  const raw = language.trim().toLowerCase().replace(/^\./, '');
  return EXTENSIONS[raw] ?? HINTS[raw] ?? 'text';
}

/** Resolve a file path, extension or plain hint to a canonical language. */
export function detectLanguage(filePathOrHint?: string): HighlightLanguage {
  if (!filePathOrHint) return 'text';
  const raw = filePathOrHint.trim().toLowerCase().replace(/[?#].*$/, '');
  if (!raw) return 'text';
  const dot = raw.lastIndexOf('.');
  if (dot !== -1) {
    const ext = raw.slice(dot + 1);
    if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  }
  const base = raw.split(/[\\/]/).pop() ?? '';
  if (/^(dockerfile|makefile|gemfile|rakefile|justfile)(\.|$)/.test(base)) return 'bash';
  return HINTS[base] ?? 'text';
}

function toLines(tokens: HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) lines.push([]);
      if (parts[index].length > 0) lines[lines.length - 1].push(Object.assign({}, token, { text: parts[index] }));
    }
  }
  return lines;
}

/**
 * Tokenize `code` into one token array per line. Input is capped so a huge
 * result cannot make highlighting expensive; `options.maxChars` overrides the
 * cap. Pass `language` as a file path or hint (see `detectLanguage`).
 */
export function highlightCode(
  code: string,
  language: HighlightLanguage | string = 'text',
  options: HighlightOptions = {}
): HighlightToken[][] {
  if (typeof code !== 'string') throw new TypeError('highlightCode expects a string');

  const requested = options.maxChars ?? MAX_HIGHLIGHT_CHARS;
  const cap = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : MAX_HIGHLIGHT_CHARS;
  const text = code.length > cap ? code.slice(0, cap) : code;
  const resolved = normalizeLanguage(language);

  if (resolved === 'text') return text.split('\n').map((line) => [{ text: line }]);

  const { regex, names, styles } = tokenizer(resolved);
  const tokens: HighlightToken[] = [];
  let last = 0;
  regex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    // A zero-width match would loop forever; skip it defensively.
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (match.index > last) tokens.push({ text: text.slice(last, match.index) });

    let rule: Rule | undefined;
    for (const name of names) {
      if (match.groups?.[name] !== undefined) {
        rule = styles.get(name);
        break;
      }
    }
    tokens.push(
      rule && !rule.plain
        ? { text: match[0], color: rule.color, bold: rule.bold, dim: rule.dim }
        : { text: match[0] }
    );
    last = regex.lastIndex;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });

  return toLines(tokens);
}

/**
 * Never let a malformed result crash a code card. On any failure this returns
 * plain, unstyled tokens for the raw text.
 */
export function safeHighlight(
  code: unknown,
  language?: HighlightLanguage | string,
  options?: HighlightOptions
): HighlightToken[][] {
  try {
    return highlightCode(code as string, language, options);
  } catch {
    return String(code ?? '').split('\n').map((text) => [{ text }]);
  }
}

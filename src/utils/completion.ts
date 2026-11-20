/**
 * completion.ts — shell completion scripts and slash-command completion.
 *
 * `bitacode completion bash|zsh|fish` prints a script for the *shell*, while
 * `completeSlash` powers completion inside the composer. Both derive from the
 * same command list so they cannot drift.
 */

export type ShellName = 'bash' | 'zsh' | 'fish';

export interface SlashCompletion {
  /** Command-line replacements, longest common prefix included. */
  matches: string[];
  /** Text to insert when exactly one candidate remains. */
  completion?: string;
}

const BIN = 'bitacode';
const SUBCOMMANDS = ['completion', 'doctor', 'help', 'permissions', 'sessions'];

/** Longest common prefix of the given strings. */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index++;
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * Complete a `/` command from the composer. Names may be passed with or without
 * the leading slash.
 */
export function completeSlash(input: string, names: readonly string[]): SlashCompletion {
  const normalized = names.map((name) => (name.startsWith('/') ? name : `/${name}`));
  const needle = input.trim().toLowerCase();
  if (!needle.startsWith('/')) return { matches: [] };

  const matches = normalized
    .filter((name) => name.toLowerCase().startsWith(needle))
    .sort((a, b) => a.localeCompare(b));
  if (matches.length === 0) return { matches: [] };
  if (matches.length === 1) return { matches, completion: `${matches[0]} ` };
  return { matches, completion: commonPrefix(matches) };
}

/** Complete a filesystem path token (used by `@` mentions and `/image`). */
export function completePathToken(
  candidates: readonly string[],
  token: string,
  limit = 20,
): { matches: string[]; completion?: string } {
  const needle = token.toLowerCase();
  const matches = candidates
    .filter((candidate) => candidate.toLowerCase().startsWith(needle))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
  if (matches.length === 0) return { matches: [] };
  if (matches.length === 1) return { matches, completion: matches[0] };
  return { matches, completion: commonPrefix(matches) };
}

/** Render a completion script for the requested shell. */
export function completionScript(shell: ShellName, bin = BIN): string {
  const subcommands = SUBCOMMANDS.join(' ');
  switch (shell) {
    case 'bash':
      return [
        `# ${bin} bash completion — install with:`,
        `#   ${bin} completion bash > /etc/bash_completion.d/${bin}`,
        `_${bin}_complete() {`,
        '  local cur prev',
        '  cur="${COMP_WORDS[COMP_CWORD]}"',
        '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
        `  if [ "$COMP_CWORD" -eq 1 ]; then`,
        `    COMPREPLY=( $(compgen -W "${subcommands}" -- "$cur") )`,
        '    return 0',
        '  fi',
        `  if [ "$prev" = "completion" ]; then`,
        '    COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )',
        '    return 0',
        '  fi',
        '  COMPREPLY=( $(compgen -f -- "$cur") )',
        '}',
        `complete -F _${bin}_complete ${bin}`,
        '',
      ].join('\n');
    case 'zsh':
      return [
        `#compdef ${bin}`,
        `# ${bin} zsh completion — install with:`,
        `#   ${bin} completion zsh > "\${fpath[1]}/_${bin}"`,
        `_${bin}() {`,
        '  local -a subcommands',
        `  subcommands=(${SUBCOMMANDS.map((name) => `'${name}'`).join(' ')})`,
        '  if (( CURRENT == 2 )); then',
        '    _describe "command" subcommands',
        '    return',
        '  fi',
        '  _files',
        '}',
        `_${bin} "$@"`,
        '',
      ].join('\n');
    case 'fish':
      return [
        `# ${bin} fish completion — install with:`,
        `#   ${bin} completion fish > ~/.config/fish/completions/${bin}.fish`,
        `complete -c ${bin} -f`,
        ...SUBCOMMANDS.map((name) => `complete -c ${bin} -n "not __fish_seen_subcommand_from ${subcommands}" -a "${name}"`),
        `complete -c ${bin} -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"`,
        `complete -c ${bin} -F`,
        '',
      ].join('\n');
    default:
      return '';
  }
}

export function isShellName(value: string): value is ShellName {
  return value === 'bash' || value === 'zsh' || value === 'fish';
}
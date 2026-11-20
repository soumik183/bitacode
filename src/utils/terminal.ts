/**
 * terminal.ts — one capability probe, read by the renderer.
 *
 * Terminals differ in ways that break a full-repaint TUI: some flicker on rapid
 * writes (Apple Terminal), some cannot show inline images (most multiplexers),
 * some have no true colour, and some are not interactive at all. Probing once at
 * startup lets the layout degrade deliberately instead of producing torn frames,
 * and gives `--legacy-tui`/`--no-ink` style escape hatches a single source of
 * truth.
 *
 * Pure: takes the environment, returns a profile. No process globals mutated.
 */

export interface TerminalProfile {
  /** Best-effort name, for the doctor output. */
  name: string;
  /** 1, 16, 256 or 16_777_216 (true colour). */
  colorDepth: number;
  trueColor: boolean;
  /** OSC 1337 / iTerm inline images. */
  inlineImages: boolean;
  /** Safe to run spinners, shimmer and thinking dots. */
  animations: boolean;
  /** Safe to repaint the live area at 30 fps. */
  stableRepaints: boolean;
  /** Assumed to render box drawing and block glyphs at one cell. */
  unicode: boolean;
  tmux: boolean;
  /** Non-interactive (CI, piped output). */
  dumb: boolean;
}

export interface ProfileInputs {
  env?: NodeJS.ProcessEnv;
  /** From settings; false wins over detection. */
  animationsEnabled?: boolean;
}

const ALWAYS_UNSTABLE = new Set(['Apple_Terminal', 'Terminal.app']);

export function detectTerminalProfile(inputs: ProfileInputs = {}): TerminalProfile {
  const env = inputs.env ?? process.env;
  const term = (env.TERM ?? '').toLowerCase();
  const program = env.TERM_PROGRAM ?? '';
  const tmux = Boolean(env.TMUX) || (env.TERM ?? '').toLowerCase().startsWith('screen');
  const dumb = term === 'dumb' || term === '' || Boolean(env.CI && env.CI !== 'false');

  let colorDepth = 16;
  if (term.includes('truecolor') || term.includes('24bit') || /truecolor|24bit/i.test(env.COLORTERM ?? '')) colorDepth = 16_777_216;
  else if (term.includes('256') || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') colorDepth = 256;
  else if (env.COLORTERM) colorDepth = 256;

  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const trueColor = !noColor && colorDepth === 16_777_216;

  const inlineImages = !dumb
    && !tmux
    && (program === 'iTerm.app' || program === 'WezTerm' || program === 'vscode' || Boolean(env.TERMUX_VERSION));

  const stableRepaints = !dumb && !ALWAYS_UNSTABLE.has(program);
  const animations = stableRepaints && inputs.animationsEnabled !== false && !dumb;

  const name = program
    || (env.TERMUX_VERSION ? 'termux' : '')
    || (tmux ? 'tmux' : '')
    || (term || 'unknown');

  return {
    name,
    colorDepth,
    trueColor,
    inlineImages,
    animations,
    stableRepaints,
    unicode: !dumb && env.LANG?.toLowerCase().includes('utf') !== false,
    tmux,
    dumb,
  };
}

/** Frame interval for animated elements, in ms. */
export function animationInterval(profile: TerminalProfile): number {
  if (!profile.animations) return 0;
  return profile.stableRepaints ? 120 : 250;
}

export function describeTerminalProfile(profile: TerminalProfile): string[] {
  const bits = [
    `terminal: ${profile.name}`,
    `colour: ${profile.colorDepth === 16_777_216 ? 'truecolor' : profile.colorDepth}`,
    `inline images: ${profile.inlineImages ? 'yes' : 'no'}`,
    `animations: ${profile.animations ? 'on' : 'off'}`,
    `stable repaints: ${profile.stableRepaints ? 'yes' : 'no'}`,
  ];
  if (profile.tmux) bits.push('multiplexer: yes');
  if (profile.dumb) bits.push('non-interactive: yes');
  return bits;
}

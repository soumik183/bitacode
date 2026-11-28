/**
 * Pure formatters for CLI update messages.
 * Kept separate from cli.tsx (which calls program.parse on import) so the
 * exact user-facing strings can be unit-tested.
 */

export type UpdateScope = 'global' | 'local';

export function formatUpToDate(current: string): string {
  return `bitacode is up to date (v${current})`;
}

export function formatUpdateAvailable(current: string, latest: string): string {
  return `Update available: v${current} → v${latest}. Run: bitacode update`;
}

/** In-app banner: the current binary is still the old one, so point at `/update`. */
export function formatUpdateNotice(current: string, latest: string): string {
  return `Update available: v${current} → v${latest} · run /update`;
}

export function formatUpdateUnavailable(): string {
  return 'Could not check for updates (offline?). Try again later.';
}

/** Collapse npm output to one bounded line for an error row or a log. */
function oneLine(text: string, max = 200): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Success line for `bitacode update` (the process that prints it is the old one). */
export function formatInstalled(previous: string, latest: string, scope: UpdateScope = 'global'): string {
  const from = previous && previous !== latest ? `v${previous} → ` : '';
  const verb = from ? 'Updated' : 'Installed';
  return `${verb} bitacode ${from}v${latest} (${scope}). Reopen bitacode to use it.`;
}

/** Failure line with the target, scope and a bounded slice of npm's output. */
export function formatInstallFailure(version: string, scope: UpdateScope, detail: string): string {
  const target = version ? `v${version} ` : '';
  const summary = oneLine(detail);
  return `Update ${target}failed (${scope})${summary ? `: ${summary}` : ''}`;
}

/**
 * Pure formatters for CLI update messages.
 * Kept separate from cli.tsx (which calls program.parse on import) so the
 * exact user-facing strings can be unit-tested.
 */

export function formatUpToDate(current: string): string {
  return `bitacode is up to date (v${current})`;
}

export function formatUpdateAvailable(current: string, latest: string): string {
  return `Update available: v${current} → v${latest}. Run: bitacode update`;
}

export function formatUpdateNotice(latest: string): string {
  return `Update available: v${latest}. Run: bitacode update`;
}

export function formatUpdateUnavailable(): string {
  return 'Could not check for updates (offline?). Try again later.';
}

export function formatInstalled(latest: string): string {
  return `Installed bitacode v${latest}. Run: bitacode`;
}

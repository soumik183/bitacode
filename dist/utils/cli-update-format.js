/**
 * Pure formatters for CLI update messages.
 * Kept separate from cli.tsx (which calls program.parse on import) so the
 * exact user-facing strings can be unit-tested.
 */
export function formatUpToDate(current) {
    return `bitacode is up to date (v${current})`;
}
export function formatUpdateAvailable(current, latest) {
    return `Update available: v${current} → v${latest}. Run: bitacode update`;
}
export function formatUpdateNotice(latest) {
    return `Update available: v${latest}. Run: bitacode update`;
}
export function formatUpdateUnavailable() {
    return 'Could not check for updates (offline?). Try again later.';
}
export function formatInstalled(latest) {
    return `Installed bitacode v${latest}. Run: bitacode`;
}

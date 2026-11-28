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
/** In-app banner: the current binary is still the old one, so point at `/update`. */
export function formatUpdateNotice(current, latest) {
    return `Update available: v${current} → v${latest} · run /update`;
}
export function formatUpdateUnavailable() {
    return 'Could not check for updates (offline?). Try again later.';
}
/** Collapse npm output to one bounded line for an error row or a log. */
function oneLine(text, max = 200) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean)
        return '';
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
/** Success line for `bitacode update` (the process that prints it is the old one). */
export function formatInstalled(previous, latest, scope = 'global') {
    const from = previous && previous !== latest ? `v${previous} → ` : '';
    const verb = from ? 'Updated' : 'Installed';
    return `${verb} bitacode ${from}v${latest} (${scope}). Reopen bitacode to use it.`;
}
/** Failure line with the target, scope and a bounded slice of npm's output. */
export function formatInstallFailure(version, scope, detail) {
    const target = version ? `v${version} ` : '';
    const summary = oneLine(detail);
    return `Update ${target}failed (${scope})${summary ? `: ${summary}` : ''}`;
}

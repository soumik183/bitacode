/** Short human-readable elapsed time for thinking indicators. */
export function formatDuration(ms) {
    const seconds = Math.max(0, ms) / 1000;
    if (seconds < 1)
        return '<1s';
    if (seconds < 60)
        return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes}m ${rest}s`;
}

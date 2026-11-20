/** Priority: live estimate → node measurement → id measurement → fallback. */
export function resolveItemRows(input) {
    for (const candidate of [input.live, input.node, input.measured, input.fallback]) {
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
            return Math.max(1, Math.round(candidate));
        }
    }
    return 1;
}

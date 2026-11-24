/** Short human-readable elapsed time for thinking indicators. */
export function formatDuration(ms: number): string {
  // A bad timer reading (NaN/Infinity) or a negative delta has no useful
  // duration; show the same safe "not started yet" label instead of "NaNs".
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  // Round once to whole seconds, then divmod: rounding the remainder separately
  // used to produce "60s" and "1m 60s" just below a minute boundary.
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

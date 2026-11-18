/**
 * Shared helpers for the search tools.
 *
 * Keyless network tools use built-in fetch with an AbortSignal timeout and
 * always return an `Error: ...` string instead of throwing. Local tools reuse
 * the validation and skip-directory conventions from their peers. Everything
 * here is shared by at least two tool files, so it lives in one place.
 */

export const NETWORK_TIMEOUT_MS = 10_000;
export const MAX_QUERY_LENGTH = 500;
export const MAX_RESULTS = 10;

// Shared "blocked by provider" detection regex (no `g` flag — .test is stateless).
const BLOCKED_PATTERN = /captcha|anomaly|unusual traffic|blocked|robot check|access denied/i;

export function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(NETWORK_TIMEOUT_MS);
}

export function isBlocked(text: string): boolean {
  return BLOCKED_PATTERN.test(text.slice(0, 5000));
}

export function validQuery(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Render one hit as `title — url — snippet` (shared by codesearch and docs). */
export function formatSearchResult(title: string, url: string, snippet: string): string {
  return `${title} — ${url} — ${snippet}`;
}

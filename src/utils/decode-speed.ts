/**
 * decode-speed.ts — live tokens-per-second while a response is streaming.
 *
 * Counts are estimated from delta characters (≈4 characters per token, with
 * CJK counted per character) until the provider reports real usage; at that point
 * the tracker is corrected, so the final number is exact and the live number is
 * close enough to be useful.
 *
 * Pure: no timers, no I/O — the caller decides when to sample.
 */

export interface DecodeSpeedSample {
  /** Formatted string such as "42.1 tok/s", or null when there is nothing to show. */
  display: string | null;
  tps: number | null;
  tokens: number;
  elapsedMs: number;
}

export interface DecodeSpeedTracker {
  add(delta: string, nowMs?: number): DecodeSpeedSample;
  /** Replace the estimate with provider-reported counts. */
  correct(outputTokens: number): void;
  sample(nowMs?: number): DecodeSpeedSample;
  reset(startedAtMs?: number): void;
  tokens(): number;
}

/** Rough token estimate: ASCII ≈ 4 chars/token, wide characters ≈ 1 token each. */
export function estimateDecodeTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) ascii++;
    else wide++;
  }
  return ascii / 4 + wide;
}

export function formatTps(tps: number | null): string | null {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return null;
  if (tps >= 100) return `${Math.round(tps)} tok/s`;
  if (tps >= 10) return `${tps.toFixed(0)} tok/s`;
  return `${tps.toFixed(1)} tok/s`;
}

export function createDecodeSpeedTracker(startedAtMs = Date.now()): DecodeSpeedTracker {
  let startedAt = startedAtMs;
  let firstTokenAt: number | null = null;
  let tokens = 0;

  const sampleAt = (nowMs: number): DecodeSpeedSample => {
    const from = firstTokenAt ?? startedAt;
    const elapsedMs = Math.max(1, nowMs - from);
    const tps = tokens > 0 && elapsedMs >= 250 ? tokens / (elapsedMs / 1000) : null;
    return {
      display: formatTps(tps),
      tps,
      tokens: Math.round(tokens),
      elapsedMs,
    };
  };

  return {
    add(delta: string, nowMs = Date.now()): DecodeSpeedSample {
      const added = estimateDecodeTokens(delta);
      if (added <= 0) return sampleAt(nowMs);
      if (firstTokenAt === null) firstTokenAt = nowMs;
      tokens += added;
      return sampleAt(nowMs);
    },
    correct(outputTokens: number): void {
      if (Number.isFinite(outputTokens) && outputTokens > 0) tokens = outputTokens;
    },
    sample(nowMs = Date.now()): DecodeSpeedSample {
      return sampleAt(nowMs);
    },
    reset(nextStartedAtMs = Date.now()): void {
      startedAt = nextStartedAtMs;
      firstTokenAt = null;
      tokens = 0;
    },
    tokens(): number {
      return Math.round(tokens);
    },
  };
}

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
/** Rough token estimate: ASCII ≈ 4 chars/token, wide characters ≈ 1 token each. */
export function estimateDecodeTokens(text) {
    if (!text)
        return 0;
    let ascii = 0;
    let wide = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x80)
            ascii++;
        else
            wide++;
    }
    return ascii / 4 + wide;
}
export function formatTps(tps) {
    if (tps === null || !Number.isFinite(tps) || tps <= 0)
        return null;
    if (tps >= 100)
        return `${Math.round(tps)} tok/s`;
    if (tps >= 10)
        return `${tps.toFixed(0)} tok/s`;
    return `${tps.toFixed(1)} tok/s`;
}
export function createDecodeSpeedTracker(startedAtMs = Date.now()) {
    let startedAt = startedAtMs;
    let firstTokenAt = null;
    let tokens = 0;
    const sampleAt = (nowMs) => {
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
        add(delta, nowMs = Date.now()) {
            const added = estimateDecodeTokens(delta);
            if (added <= 0)
                return sampleAt(nowMs);
            if (firstTokenAt === null)
                firstTokenAt = nowMs;
            tokens += added;
            return sampleAt(nowMs);
        },
        correct(outputTokens) {
            if (Number.isFinite(outputTokens) && outputTokens > 0)
                tokens = outputTokens;
        },
        sample(nowMs = Date.now()) {
            return sampleAt(nowMs);
        },
        reset(nextStartedAtMs = Date.now()) {
            startedAt = nextStartedAtMs;
            firstTokenAt = null;
            tokens = 0;
        },
        tokens() {
            return Math.round(tokens);
        },
    };
}

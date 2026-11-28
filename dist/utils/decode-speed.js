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
const graphemeSegmenter = (() => {
    try {
        const Segmenter = Intl.Segmenter;
        return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
    }
    catch {
        return null;
    }
})();
/** Code points that modify a neighbour rather than adding a token of their own. */
function isModifier(cp) {
    return (cp === 0x200d || // ZWJ: joins emoji into one grapheme
        cp === 0xfeff ||
        (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
        (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) ||
        (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
        (cp >= 0xfe20 && cp <= 0xfe2f) ||
        (cp >= 0xe0100 && cp <= 0xe01ef) || // supplementary variation selectors
        (cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji skin-tone modifiers
    );
}
/** First meaningful code point of a grapheme, or -1 for modifier-only clusters. */
function baseCodePoint(cluster) {
    for (const char of cluster) {
        const cp = char.codePointAt(0) ?? 0;
        // Surviving lone surrogates are half a split pair, not a token.
        if (cp >= 0xd800 && cp <= 0xdfff || isModifier(cp))
            continue;
        return cp;
    }
    return -1;
}
/** Rough token estimate: ASCII ≈ 4 chars/token, wide graphemes ≈ 1 token each. */
export function estimateDecodeTokens(text) {
    if (!text)
        return 0;
    let ascii = 0;
    let wide = 0;
    if (graphemeSegmenter) {
        for (const { segment } of graphemeSegmenter.segment(text)) {
            const cp = baseCodePoint(segment);
            if (cp < 0)
                continue;
            if (cp < 0x80)
                ascii += 1;
            else
                wide += 1;
        }
    }
    else {
        for (const char of text) {
            const cp = baseCodePoint(char);
            if (cp < 0)
                continue;
            if (cp < 0x80)
                ascii += 1;
            else
                wide += 1;
        }
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
    // A stream can split a surrogate pair across two deltas; hold the trailing
    // high surrogate so the pair is counted once instead of twice.
    let pendingHighSurrogate = '';
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
            let combined = delta;
            let orphan = 0;
            if (pendingHighSurrogate) {
                const first = combined.charCodeAt(0);
                if (first >= 0xdc00 && first <= 0xdfff) {
                    combined = pendingHighSurrogate + combined;
                    pendingHighSurrogate = '';
                }
                else {
                    // The previous chunk ended mid-pair but this one did not complete it.
                    orphan = 1;
                    pendingHighSurrogate = '';
                }
            }
            if (combined.length > 0) {
                const last = combined.charCodeAt(combined.length - 1);
                if (last >= 0xd800 && last <= 0xdbff) {
                    pendingHighSurrogate = combined.slice(-1);
                    combined = combined.slice(0, -1);
                }
            }
            const added = estimateDecodeTokens(combined) + orphan;
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
            pendingHighSurrogate = '';
        },
        tokens() {
            return Math.round(tokens);
        },
    };
}

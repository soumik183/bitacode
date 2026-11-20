/**
 * context-layers.ts — keeps the prompt prefix stable so providers can cache it.
 *
 * Prompt caching only pays off when the *beginning* of the request is
 * byte-identical between turns. That means the static system prompt and the
 * slowly-changing context (repo snapshot, memory) must come first, while
 * per-turn frames (working checkpoint, hook output) go at the very end, after the
 * conversation.
 *
 * `buildLayeredMessages` enforces that order, strips stale copies of the volatile
 * frames, and returns a hash of the stable prefix so the UI can show whether the
 * cache is actually hitting.
 */
import { createHash } from 'node:crypto';
/** Marker prefixed to every injected frame so stale copies can be identified. */
export const VOLATILE_FRAME_MARKER = '[runtime-frame:';
export function volatileFrame(id, text) {
    return `${VOLATILE_FRAME_MARKER}${id}]\n${text}`;
}
export function isVolatileFrame(content) {
    return typeof content === 'string' && content.startsWith(VOLATILE_FRAME_MARKER);
}
/** Which frame id a message belongs to, or null. */
export function volatileFrameId(content) {
    if (!isVolatileFrame(content))
        return null;
    const match = /^\[runtime-frame:([^\]]+)\]/.exec(content);
    return match ? match[1] : null;
}
export function hashText(text) {
    return createHash('sha1').update(text).digest('hex').slice(0, 12);
}
const DEFAULT_MAX_VOLATILE = 6_000;
/**
 * Compose the request:
 *
 *   [system(stable)] + history + [volatile frames]
 *
 * Volatile frames live at the tail on purpose: inserting them before the history
 * would invalidate the cache for every message after them.
 */
export function buildLayeredMessages(input) {
    const maxVolatile = input.maxVolatileChars ?? DEFAULT_MAX_VOLATILE;
    const stableLayers = (input.layers ?? []).filter((layer) => layer.stability === 'stable' && layer.text.trim());
    const volatileLayers = (input.layers ?? []).filter((layer) => layer.stability === 'volatile' && layer.text.trim());
    const systemParts = [input.system.trim(), ...stableLayers.map((layer) => layer.text.trim())].filter(Boolean);
    const systemText = systemParts.join('\n\n');
    // Drop previously injected volatile frames from the history being rebuilt.
    const history = input.history.filter((message) => !(message?.role === 'system' && isVolatileFrame(message.content)));
    let volatileChars = 0;
    const frames = [];
    const volatileIds = [];
    for (const layer of volatileLayers) {
        if (volatileChars >= maxVolatile)
            break;
        const remaining = maxVolatile - volatileChars;
        const body = layer.text.length <= remaining
            ? layer.text
            : `${layer.text.slice(0, Math.max(0, remaining - 24))}\n…[frame truncated]`;
        const content = volatileFrame(layer.id, body);
        volatileChars += content.length;
        volatileIds.push(layer.id);
        frames.push({ role: 'system', content });
    }
    return {
        messages: [{ role: 'system', content: systemText }, ...history, ...frames],
        stableHash: hashText(systemText),
        stableChars: systemText.length,
        volatileChars,
        volatileIds,
    };
}
/** "cache 82% · 12.3k in / 840 out · $0.0042", or null when nothing is known. */
export function formatUsageSummary(usage) {
    if (!usage)
        return null;
    const parts = [];
    if (usage.cachedTokens && usage.promptTokens && usage.promptTokens > 0) {
        const ratio = Math.round((usage.cachedTokens / usage.promptTokens) * 100);
        parts.push(`cache ${Math.min(100, ratio)}%`);
    }
    const compact = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)));
    if (usage.promptTokens || usage.completionTokens) {
        parts.push(`${compact(usage.promptTokens ?? 0)} in / ${compact(usage.completionTokens ?? 0)} out`);
    }
    if (typeof usage.costUsd === 'number' && usage.costUsd > 0) {
        parts.push(`$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(3)}`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
}
/** Read cache statistics from the shapes different providers use. */
export function extractCacheUsage(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const promptTokens = firstNumber(raw.prompt_tokens, raw.input_tokens, raw.promptTokens);
    const completionTokens = firstNumber(raw.completion_tokens, raw.output_tokens, raw.completionTokens);
    const cachedTokens = firstNumber(raw.prompt_tokens_details?.cached_tokens, raw.input_tokens_details?.cached_tokens, raw.cache_read_input_tokens, raw.cached_tokens);
    const usage = {};
    if (promptTokens !== undefined)
        usage.promptTokens = promptTokens;
    if (completionTokens !== undefined)
        usage.completionTokens = completionTokens;
    if (cachedTokens !== undefined)
        usage.cachedTokens = cachedTokens;
    return usage;
}
function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
    }
    return undefined;
}

/**
 * Token estimation and cost tracking.
 *
 * Uses a rough heuristic (~4 chars per token) for estimation.
 * Prefers actual usage data from the API when available.
 */
/** Rough token estimation: ~4 characters per token. */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/** Estimate tokens for a single message including overhead. */
export function estimateMessageTokens(msg) {
    let tokens = 4; // per-message overhead
    if ('content' in msg && typeof msg.content === 'string') {
        tokens += estimateTokens(msg.content);
    }
    if ('tool_calls' in msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            // Type guard for function tool calls
            if (tc.type === 'function' && 'function' in tc) {
                tokens += estimateTokens(tc.function.name || '') + estimateTokens(tc.function.arguments || '') + 10;
            }
        }
    }
    return tokens;
}
/** Estimate total tokens for a conversation. */
export function estimateConversationTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) + 10;
}
/** Calculate dollar cost for a given number of tokens. */
export function calculateCost(inputTokens, outputTokens, pricing, cachedTokens) {
    if (cachedTokens && cachedTokens > 0 && pricing.cachedPerToken != null) {
        const uncachedTokens = inputTokens - cachedTokens;
        return (uncachedTokens * pricing.inputPerToken +
            cachedTokens * pricing.cachedPerToken +
            outputTokens * pricing.outputPerToken);
    }
    return inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken;
}
/** Get context window utilisation info. */
export function getContextInfo(messages, pricing) {
    const currentTokens = estimateConversationTokens(messages);
    const maxTokens = pricing.contextWindow;
    const utilizationPercentage = maxTokens > 0 ? (currentTokens / maxTokens) * 100 : 0;
    return {
        currentTokens,
        maxTokens,
        utilizationPercentage,
        needsCompaction: utilizationPercentage >= 90,
    };
}
/** Build a UsageInfo from actual or estimated token counts. */
export function createUsageInfo(inputTokens, outputTokens, pricing, cachedTokens) {
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost: calculateCost(inputTokens, outputTokens, pricing, cachedTokens),
    };
}

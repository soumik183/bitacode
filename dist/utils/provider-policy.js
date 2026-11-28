/**
 * provider-policy.ts — model allow/deny policy and jittered retry decisions.
 *
 * Pure decision helpers extracted from the agentic loop:
 *
 *   parseProviderPolicy(config) -> checkModelPolicy(model, policy)
 *   classifyFailure(error, status) -> retryDecision({ ... })
 *
 * Policy evaluation fails closed: a malformed list denies every model, an
 * empty/invalid model identifier is denied, and a malformed policy value is
 * never allowed to widen access. Retry decisions never throw and always yield
 * a finite, non-negative delay, even for hostile or broken inputs.
 */
import { logger } from './logger.js';
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 200;
const MAX_MODEL_LENGTH = 512;
const MIN_RETRIES = 0;
const MAX_RETRIES = 10;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 30_000;
const JITTER_RATIO = 0.2;
/** A malformed model list is replaced with an explicit deny-all list. */
const DENY_ALL_PATTERN = '*';
const RATE_PATTERN = /rate[_\s-]?limit|too many requests|quota|resource[_\s-]?exhausted|usage limit|throttl|slow down|retry.after/i;
const BAD_STREAM_400_PATTERN = /incomplete|stream/i;
const INCOMPLETE_PATTERN = /incomplete[_\s-]?(?:stream|response|message|body)|stream (?:ended|closed|truncated|terminated) (?:unexpectedly|early|prematurely)|premature(?:ly)? clos|unexpected end of (?:stream|response)|partial (?:stream|response)/i;
const CONTENT_FILTER_PATTERN = /content[_\s-]?filter|content[_\s-]?policy|(?:safety|moderation)[_\s-]?(?:filter|check|block|reject)|inappropriate content|policy violation|blocked by (?:the )?(?:filter|policy|moderator)|flagged content/i;
const TRANSPORT_PATTERN = /ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ENOTFOUND|EPIPE|ERR_NETWORK|abort(?:ed|ing)?|network|socket hang up|fetch failed|connection (?:closed|reset|refused|timed out)|timed out/i;
/** Read a property without letting a throwing getter escape. */
function read(obj, key) {
    try {
        if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function'))
            return undefined;
        return obj[key];
    }
    catch {
        return undefined;
    }
}
/** Short, printable preview of an untrusted value for debug output. */
function preview(value) {
    try {
        const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
        return text.slice(0, 60);
    }
    catch {
        return '<unprintable>';
    }
}
function isValidText(value, maxLength) {
    return (typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength &&
        !/[\u0000-\u001f\u007f]/.test(value));
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function finiteNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
/**
 * Anchored, case-insensitive `*` / `?` match. Uses a linear backtracking
 * pointer pair rather than building a regexp from configuration, so a hostile
 * pattern cannot trigger catastrophic regexp backtracking.
 */
function globMatches(pattern, value) {
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    let pi = 0;
    let vi = 0;
    let star = -1;
    let starVi = 0;
    while (vi < v.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) {
            pi++;
            vi++;
            continue;
        }
        if (pi < p.length && p[pi] === '*') {
            star = pi++;
            starVi = vi;
            continue;
        }
        if (star >= 0) {
            pi = star + 1;
            vi = ++starVi;
            continue;
        }
        return false;
    }
    while (pi < p.length && p[pi] === '*')
        pi++;
    return pi === p.length;
}
/** Keep usable patterns only; invalid entries are skipped with a debug log. */
function usablePatterns(value, label) {
    if (!Array.isArray(value))
        return [];
    const patterns = [];
    for (const raw of value.slice(0, MAX_PATTERNS)) {
        if (!isValidText(raw, MAX_PATTERN_LENGTH)) {
            logger.debug(`Ignoring invalid ${label} pattern`, { pattern: preview(raw) });
            continue;
        }
        patterns.push(raw.trim());
    }
    return patterns;
}
/**
 * Normalise a config object into a policy. Top-level values that are not plain
 * objects produce `{}`. A recognized field with the wrong type fails closed by
 * denying all models (or disabling retries) rather than silently widening the
 * policy. Lists are capped at 200 entries and retries at 0..10.
 */
export function parseProviderPolicy(value) {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            // A configured-but-malformed policy must never silently widen access.
            logger.warn('Malformed provider policy; denying all models');
            return { deniedModels: [DENY_ALL_PATTERN] };
        }
        const source = value;
        const hasAllowed = Object.prototype.hasOwnProperty.call(source, 'allowedModels');
        const hasDenied = Object.prototype.hasOwnProperty.call(source, 'deniedModels');
        const hasRetries = Object.prototype.hasOwnProperty.call(source, 'maxRetries');
        if (!hasAllowed && !hasDenied && !hasRetries) {
            logger.debug('Provider policy has no recognized fields; ignoring');
            return {};
        }
        const policy = {};
        if ((hasAllowed && !Array.isArray(source.allowedModels)) || (hasDenied && !Array.isArray(source.deniedModels))) {
            logger.warn('Malformed provider policy model list; denying all models');
            policy.deniedModels = [DENY_ALL_PATTERN];
        }
        else {
            if (hasAllowed) {
                const patterns = usablePatterns(source.allowedModels, 'allowedModels');
                if (patterns.length === 0) {
                    logger.warn('Malformed empty allowedModels; denying all models');
                    policy.deniedModels = [DENY_ALL_PATTERN];
                }
                else {
                    policy.allowedModels = patterns;
                }
            }
            if (hasDenied)
                policy.deniedModels = usablePatterns(source.deniedModels, 'deniedModels');
        }
        if (hasRetries) {
            const raw = source.maxRetries;
            if (typeof raw === 'number' && Number.isFinite(raw)) {
                policy.maxRetries = clamp(Math.floor(raw), MIN_RETRIES, MAX_RETRIES);
            }
            else {
                logger.warn('Malformed provider policy maxRetries; disabling retries');
                policy.maxRetries = MIN_RETRIES;
            }
        }
        return policy;
    }
    catch (err) {
        logger.warn('Failed to parse provider policy; denying all models', { error: preview(err) });
        return { deniedModels: [DENY_ALL_PATTERN] };
    }
}
/**
 * Decide whether a model may be used. Deny rules always win, an empty allowlist
 * allows every valid model, and invalid patterns/models are ignored/denied.
 */
export function checkModelPolicy(model, policy) {
    try {
        if (!isValidText(model, MAX_MODEL_LENGTH)) {
            return { allowed: false, reason: 'invalid or empty model identifier' };
        }
        const name = model.trim();
        for (const pattern of usablePatterns(read(policy, 'deniedModels'), 'deniedModels')) {
            if (globMatches(pattern, name)) {
                return { allowed: false, reason: `model matches deniedModels pattern "${pattern}"` };
            }
        }
        const allowed = usablePatterns(read(policy, 'allowedModels'), 'allowedModels');
        // A present-but-unusable allowlist is a configuration error, not consent.
        if (allowed.length === 0 &&
            policy && typeof policy === 'object' &&
            Object.prototype.hasOwnProperty.call(policy, 'allowedModels')) {
            return { allowed: false, reason: 'allowedModels is empty or malformed' };
        }
        if (allowed.length === 0)
            return { allowed: true };
        for (const pattern of allowed) {
            if (globMatches(pattern, name))
                return { allowed: true };
        }
        return { allowed: false, reason: 'model does not match any allowedModels pattern' };
    }
    catch (err) {
        logger.debug('Model policy check failed; denying', { error: preview(err) });
        return { allowed: false, reason: 'policy evaluation failed' };
    }
}
function normalizeStatus(value) {
    let raw = value;
    if (typeof raw === 'string' && /^\d{3}$/.test(raw))
        raw = Number(raw);
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 100 || raw > 599)
        return null;
    return raw;
}
function statusFrom(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
        return null;
    for (const key of ['status', 'statusCode']) {
        const status = normalizeStatus(read(error, key));
        if (status !== null)
            return status;
    }
    for (const key of ['response', 'cause']) {
        const nested = read(error, key);
        if (nested === null || (typeof nested !== 'object' && typeof nested !== 'function'))
            continue;
        for (const field of ['status', 'statusCode']) {
            const status = normalizeStatus(read(nested, field));
            if (status !== null)
                return status;
        }
    }
    return null;
}
/** Collect diagnostic text from the shapes providers actually throw. */
function errorMessage(error) {
    try {
        const parts = [];
        if (typeof error === 'string') {
            parts.push(error);
        }
        else if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
            for (const key of ['message', 'code', 'reason', 'statusText']) {
                const part = read(error, key);
                if (typeof part === 'string' && part.length > 0)
                    parts.push(part);
            }
            const nested = read(error, 'cause');
            if (nested !== null && (typeof nested === 'object' || typeof nested === 'function')) {
                for (const key of ['message', 'code']) {
                    const part = read(nested, key);
                    if (typeof part === 'string' && part.length > 0)
                        parts.push(part);
                }
            }
        }
        return parts.join(' ').slice(0, 2_000);
    }
    catch {
        return '';
    }
}
/**
 * Classify a provider failure. Status codes take precedence, then message and
 * error-code keywords. Unknown or unreadable inputs are `permanent`.
 */
export function classifyFailure(error, status) {
    try {
        const resolvedStatus = normalizeStatus(status) ?? statusFrom(error);
        const message = errorMessage(error);
        if (resolvedStatus === 429)
            return 'rate_limit';
        if (resolvedStatus !== null && resolvedStatus >= 500 && resolvedStatus <= 599)
            return 'server';
        if (resolvedStatus === 408 || resolvedStatus === 409 || resolvedStatus === 425)
            return 'transport';
        if (resolvedStatus === 400 && BAD_STREAM_400_PATTERN.test(message))
            return 'incomplete_stream';
        if (CONTENT_FILTER_PATTERN.test(message))
            return 'content_filter';
        if (RATE_PATTERN.test(message))
            return 'rate_limit';
        if (INCOMPLETE_PATTERN.test(message))
            return 'incomplete_stream';
        if (TRANSPORT_PATTERN.test(message))
            return 'transport';
        if (resolvedStatus !== null && resolvedStatus >= 400 && resolvedStatus <= 499)
            return 'permanent';
        return 'permanent';
    }
    catch (err) {
        logger.debug('Failure classification failed; treating as permanent', { error: preview(err) });
        return 'permanent';
    }
}
function retryBudget(maxRetries) {
    return clamp(Math.floor(finiteNumber(maxRetries, DEFAULT_MAX_RETRIES)), MIN_RETRIES, MAX_RETRIES);
}
/**
 * Compute one retry decision. `attempt` is the 1-based failed-attempt number;
 * retries are available through `attempt <= maxRetries + 1`. Backoff is
 * `base * 2^(attempt-1)` capped at 30s, multiplied by a jitter factor in
 * [0.8, 1.2] from `rng`. A larger finite `retryAfterMs` wins as-is.
 */
export function retryDecision(options) {
    try {
        const attempt = Math.max(1, Math.floor(finiteNumber(read(options, 'attempt'), 1)));
        const kind = classifyFailure(read(options, 'error'), read(options, 'status'));
        const maxRetries = retryBudget(read(options, 'maxRetries'));
        if (kind === 'content_filter' || kind === 'permanent') {
            return { retry: false, delayMs: 0, kind, attempt, reason: `not retryable: ${kind}` };
        }
        if (attempt > maxRetries + 1) {
            return {
                retry: false,
                delayMs: 0,
                kind,
                attempt,
                reason: `retry budget exhausted after ${maxRetries + 1} attempts`,
            };
        }
        const base = clamp(finiteNumber(read(options, 'baseDelayMs'), DEFAULT_BASE_DELAY_MS), 0, MAX_BACKOFF_MS);
        let nominal = base;
        for (let i = 1; i < attempt; i++)
            nominal *= BACKOFF_MULTIPLIER;
        nominal = Math.min(nominal, MAX_BACKOFF_MS);
        const rng = read(options, 'rng');
        const rawRandom = typeof rng === 'function' ? rng() : Math.random();
        const random = clamp(finiteNumber(rawRandom, 0.5), 0, 1);
        const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * random;
        const jittered = clamp(Math.round(nominal * factor), 0, MAX_BACKOFF_MS);
        const retryAfter = finiteNumber(read(options, 'retryAfterMs'), -1);
        const delayMs = retryAfter >= 0 && retryAfter > jittered ? Math.round(retryAfter) : jittered;
        return { retry: true, delayMs, kind, attempt };
    }
    catch (err) {
        logger.debug('Retry decision failed; refusing to retry', { error: preview(err) });
        return { retry: false, delayMs: 0, kind: 'permanent', attempt: 1, reason: 'invalid retry options' };
    }
}

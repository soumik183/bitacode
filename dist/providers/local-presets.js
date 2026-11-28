/**
 * Ready-made presets for local / self-hosted OpenAI-compatible servers.
 *
 * This module is config-only: it never performs network I/O. Presets describe
 * well-known loopback endpoints and are converted into the same provider
 * config shape consumed by `runtime-config.ts` / `providers/index.ts`.
 *
 * Model entries are intentionally generic placeholders with zero pricing.
 * They exist so a preset is immediately usable; users are expected to override
 * model ids, context windows and prices in their own `bitacode.jsonc`.
 */
import { logger } from '../utils/logger.js';
/**
 * Curated loopback presets. The `note` documents the assumed context window
 * and reminds users that the bundled models are placeholders.
 *
 * NOTE: presence in this list does not imply a server is running. Detection is
 * explicit and never performs real network requests unless a `probe` is
 * injected (see `detectLocalServers`).
 */
export const LOCAL_PRESETS = [
    {
        id: 'ollama',
        name: 'Ollama (local)',
        baseURL: 'http://127.0.0.1:11434/v1',
        note: 'Ollama OpenAI-compatible endpoint. Default model contextWindow is 8192; override per model in config.',
        models: {
            'ollama-default': {
                name: 'Ollama default model',
                contextWindow: 8192,
                inputPricePerMillion: 0,
                outputPricePerMillion: 0,
            },
        },
    },
    {
        id: 'lmstudio',
        name: 'LM Studio (local)',
        baseURL: 'http://127.0.0.1:1234/v1',
        note: 'LM Studio OpenAI-compatible endpoint. Default model contextWindow is 8192; override per model in config.',
        models: {
            'lmstudio-default': {
                name: 'LM Studio default model',
                contextWindow: 8192,
                inputPricePerMillion: 0,
                outputPricePerMillion: 0,
            },
        },
    },
    {
        id: 'vllm',
        name: 'vLLM (local)',
        baseURL: 'http://127.0.0.1:8000/v1',
        note: 'vLLM OpenAI-compatible endpoint. Default model contextWindow is 4096; override per model in config.',
        models: {
            'vllm-default': {
                name: 'vLLM default model',
                contextWindow: 4096,
                inputPricePerMillion: 0,
                outputPricePerMillion: 0,
            },
        },
    },
    {
        id: 'localai',
        name: 'LocalAI (local)',
        baseURL: 'http://127.0.0.1:8080/v1',
        note: 'LocalAI OpenAI-compatible endpoint. Default model contextWindow is 4096; override per model in config.',
        models: {
            'local-model': {
                name: 'LocalAI default model',
                contextWindow: 4096,
                inputPricePerMillion: 0,
                outputPricePerMillion: 0,
            },
        },
    },
];
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/** Trim + validate an id; returns undefined for anything unusable. */
function normalizeId(value) {
    if (typeof value !== 'string')
        return undefined;
    const id = value.trim();
    return id.length > 0 ? id : undefined;
}
/** Accept only absolute http(s) URLs, preserving the caller's original text. */
function normalizeBaseURL(value) {
    const url = normalizeId(value);
    if (!url)
        return undefined;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
/** Finite, non-negative numbers only; malformed values become `fallback`. */
function safeNumber(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(0, value);
}
/**
 * Convert a preset into a runtime provider config entry.
 *
 * The provider `apiKey` is the preset id: local servers generally ignore the
 * key, but the OpenAI-compatible SDK requires one to be present. Users can
 * override it in their own config.
 *
 * Invalid input never throws; a malformed preset yields an empty object and
 * malformed model entries are skipped.
 */
export function presetToProviderConfig(preset) {
    if (!isPlainObject(preset))
        return {};
    const id = normalizeId(preset.id);
    if (!id)
        return {};
    const name = normalizeId(preset.name) ?? id;
    const baseURL = normalizeBaseURL(preset.baseURL);
    const models = {};
    if (isPlainObject(preset.models)) {
        for (const [rawModelId, rawModel] of Object.entries(preset.models)) {
            const modelId = normalizeId(rawModelId);
            if (!modelId || !isPlainObject(rawModel))
                continue;
            models[modelId] = {
                name: normalizeId(rawModel.name) ?? modelId,
                contextWindow: safeNumber(rawModel.contextWindow, 0),
                inputPricePerMillion: safeNumber(rawModel.inputPricePerMillion, 0),
                outputPricePerMillion: safeNumber(rawModel.outputPricePerMillion, 0),
            };
        }
    }
    return {
        name,
        ...(baseURL ? { baseURL } : {}),
        apiKey: id,
        models,
    };
}
/**
 * Merge local presets into an existing providers map.
 *
 * - Existing ids always win (project / user config takes precedence).
 * - `include` restricts additions to the named preset ids; unknown ids are
 *   ignored and an empty list adds nothing.
 * - Bad inputs (null, arrays, malformed options) are tolerated, never thrown.
 * - The input object is never mutated; a new shallow copy is returned.
 */
export function mergeLocalPresets(existing, options) {
    const merged = isPlainObject(existing) ? { ...existing } : {};
    const rawInclude = isPlainObject(options) ? options.include : undefined;
    const includeSet = Array.isArray(rawInclude)
        ? new Set(rawInclude.filter((id) => typeof id === 'string'))
        : undefined;
    for (const preset of LOCAL_PRESETS) {
        const id = normalizeId(preset?.id);
        if (!id)
            continue;
        if (Object.prototype.hasOwnProperty.call(merged, id))
            continue;
        if (includeSet && !includeSet.has(id))
            continue;
        merged[id] = presetToProviderConfig(preset);
    }
    return merged;
}
/**
 * Detect which local presets appear to be available.
 *
 * IMPORTANT: this function performs NO real network requests by default.
 * Without an injected `probe` it resolves to an empty array. Callers that want
 * detection must supply `probe(url) => Promise<boolean>`, which is typically
 * backed by the host application's HTTP client.
 *
 * Every probe is awaited independently. A probe that rejects (or throws
 * synchronously) is treated as `false` and reported through `logger.debug`;
 * it never rejects `detectLocalServers` itself.
 */
export async function detectLocalServers(options) {
    const probe = isPlainObject(options) ? options.probe : undefined;
    // No probe: deliberately do not touch the network. See the note above.
    if (typeof probe !== 'function') {
        logger.debug('Local preset detection skipped: no probe injected (no network requests performed)');
        return [];
    }
    const check = probe;
    const detected = await Promise.all(LOCAL_PRESETS.map(async (preset) => {
        const id = normalizeId(preset?.id);
        if (!id)
            return null;
        let available = false;
        try {
            available = Boolean(await check(preset.baseURL));
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.debug('Local preset probe rejected', { id, url: preset.baseURL, error: detail });
            available = false;
        }
        return available ? id : null;
    }));
    return detected.filter((id) => id !== null);
}

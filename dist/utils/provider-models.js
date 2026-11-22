import { getProvider, getModelDetails } from '../providers/index.js';
import { readModelCache, writeModelCache } from './model-cache.js';
import { logger } from './logger.js';
// Providers expose chat and non-chat models on the same OpenAI-compatible
// /models endpoint. Hide the obvious non-chat families; if that removes
// everything, keep the raw list rather than showing an empty picker.
const NON_CHAT_MODEL = /(embedding|whisper|tts|dall-e|moderation|transcribe|speech|image|audio|sora|^gpt-3\.5-turbo-instruct$|babbage|davinci)/i;
const MAX_MODELS = 300;
/**
 * Network budget for a model-list request. The list is small and the endpoint
 * answers in well under a second when it is healthy; four seconds keeps a
 * hanging proxy from pinning the picker open.
 */
export const MODEL_FETCH_TIMEOUT_MS = 4_000;
/** In-process layer so repeated picker opens skip both disk and network. */
const memoryCache = new Map();
/** Shared promise per provider so concurrent callers make one request. */
const inflight = new Map();
const CACHE_TTL_MS = 5 * 60_000;
/**
 * Synchronous context-window lookup from the already-fetched model catalogs.
 * Used by the footer so a remote-only model gets its real limit without a
 * network call at render time. Returns undefined when nothing was fetched yet.
 */
export function getCachedContextWindow(providerId, modelId) {
    for (const [key, entry] of memoryCache) {
        if (!key.startsWith(`${providerId}::`))
            continue;
        const model = entry.items.find((item) => item.id === modelId);
        if (model?.contextWindow && model.contextWindow > 0)
            return model.contextWindow;
    }
    return undefined;
}
export function formatContextWindow(contextWindow) {
    if (!contextWindow || contextWindow <= 0)
        return undefined;
    if (contextWindow >= 1_000_000) {
        return `${Number((contextWindow / 1_000_000).toFixed(1))}M ctx`;
    }
    return `${Math.round(contextWindow / 1000)}k ctx`;
}
function keyFor(providerId, baseURL) {
    return `${providerId}::${baseURL ?? ''}`;
}
/** Built-in/configured models, used when the network is slow, absent or partial. */
export function staticModels(providerId) {
    return (getProvider(providerId)?.models ?? []).map((model) => ({
        id: model.id,
        label: model.name || model.id,
        description: formatContextWindow(model.contextWindow),
        contextWindow: model.contextWindow,
    }));
}
/** De-duplicates by id, keeping the richer of the two entries. */
function mergeWithStatic(providerId, remote) {
    const merged = new Map();
    for (const model of staticModels(providerId))
        merged.set(model.id, model);
    for (const model of remote) {
        const known = merged.get(model.id);
        merged.set(model.id, {
            ...known,
            ...model,
            label: model.label || known?.label || model.id,
            contextWindow: model.contextWindow ?? known?.contextWindow,
            description: model.description ?? known?.description,
        });
    }
    const chat = Array.from(merged.values()).filter((model) => !NON_CHAT_MODEL.test(model.id));
    return (chat.length > 0 ? chat : Array.from(merged.values()))
        .sort((a, b) => a.label.localeCompare(b.label))
        .slice(0, MAX_MODELS);
}
function describeFetchError(err) {
    const status = Number(err?.status ?? err?.response?.status ?? 0);
    const message = String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 200);
    // Some providers report a bad key as 400 (Google) instead of 401.
    const keyRejected = status === 401 ||
        status === 403 ||
        (status >= 400 && status < 500 && /(api.?key|unauthorized|authentication|permission)/i.test(message));
    return { error: message, authError: keyRejected };
}
async function fetchFromNetwork(client, providerId, timeoutMs) {
    try {
        const page = await client.models.list({ timeout: timeoutMs, maxRetries: 0 });
        const data = page.data;
        if (!Array.isArray(data)) {
            return { items: staticModels(providerId), error: 'The provider returned no model list.', authError: false };
        }
        const seen = new Set();
        const remote = [];
        for (const raw of data) {
            const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            const details = getModelDetails(providerId, id);
            const rawContext = Number(raw.context_length ?? raw.context_window ?? 0);
            const contextWindow = rawContext > 0 ? rawContext : details?.contextWindow;
            const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : details?.name;
            remote.push({
                id,
                label: name ?? id,
                description: formatContextWindow(contextWindow),
                contextWindow,
            });
        }
        return { items: mergeWithStatic(providerId, remote), error: null, authError: false };
    }
    catch (err) {
        return { items: staticModels(providerId), ...describeFetchError(err) };
    }
}
/**
 * Fetch a provider's live model list through its OpenAI-compatible API.
 *
 * Fast path: a fresh disk/memory cache answers synchronously. When the cache is
 * stale the stale list is returned immediately and a refresh runs in the
 * background, so the picker never waits on a slow provider. The request itself
 * is coalesced per provider and bounded by {@link MODEL_FETCH_TIMEOUT_MS}.
 */
export async function listProviderModels(client, providerId, options = {}) {
    const { timeoutMs = MODEL_FETCH_TIMEOUT_MS, baseURL, useCache = true, refresh = false } = options;
    const key = keyFor(providerId, baseURL);
    const now = Date.now();
    if (useCache && !refresh) {
        const memory = memoryCache.get(key);
        if (memory && now - memory.fetchedAt < CACHE_TTL_MS) {
            return { items: memory.items, error: null, authError: false, fromCache: true, stale: false };
        }
        const disk = await readModelCache(providerId, baseURL, now);
        if (disk) {
            const items = mergeWithStatic(providerId, disk.items);
            memoryCache.set(key, { items, fetchedAt: disk.fetchedAt });
            if (!disk.stale) {
                return { items, error: null, authError: false, fromCache: true, stale: false };
            }
            // Stale-while-revalidate: hand back what we have and refresh behind it.
            void refreshInBackground(client, providerId, key, baseURL, timeoutMs);
            return { items, error: null, authError: false, fromCache: true, stale: true };
        }
    }
    // Re-check after the disk read: a concurrent caller may have finished while
    // this call was waiting on the file system.
    const fresh = memoryCache.get(key);
    if (fresh && Date.now() - fresh.fetchedAt < CACHE_TTL_MS) {
        return { items: fresh.items, error: null, authError: false, fromCache: true, stale: false };
    }
    const pending = inflight.get(key);
    if (pending)
        return pending;
    const request = (async () => {
        const result = await fetchFromNetwork(client, providerId, timeoutMs);
        if (result.items.length > 0) {
            memoryCache.set(key, { items: result.items, fetchedAt: Date.now() });
            // Awaited so a one-shot process (headless -p, CLI subcommands) still
            // leaves a warm cache behind; a small write is far cheaper than a fetch.
            await writeModelCache(providerId, baseURL, result.items);
        }
        return result;
    })();
    inflight.set(key, request);
    try {
        return await request;
    }
    finally {
        inflight.delete(key);
    }
}
async function refreshInBackground(client, providerId, key, baseURL, timeoutMs) {
    if (inflight.has(key))
        return;
    const request = (async () => {
        try {
            const result = await fetchFromNetwork(client, providerId, timeoutMs);
            if (result.items.length > 0 && !result.error) {
                memoryCache.set(key, { items: result.items, fetchedAt: Date.now() });
                await writeModelCache(providerId, baseURL, result.items);
            }
        }
        catch (error) {
            // Background refresh is best effort.
            logger.debug('Model list refresh failed', { providerId, error: String(error?.message ?? error) });
        }
    })();
    inflight.set(key, request);
    try {
        await request;
    }
    finally {
        inflight.delete(key);
    }
}
/** Warm the cache without blocking startup or the UI. */
export function prefetchProviderModels(client, providerId, options = {}) {
    const key = keyFor(providerId, options.baseURL);
    const memory = memoryCache.get(key);
    if (memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS)
        return;
    void refreshInBackground(client, providerId, key, options.baseURL, options.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS);
}
/** Test hook: drop the in-process layer so disk behaviour is observable. */
export function resetModelListMemoryCacheForTests() {
    memoryCache.clear();
    inflight.clear();
}

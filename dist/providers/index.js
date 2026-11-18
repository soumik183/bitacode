/**
 * Provider and model registry.
 *
 * Built-in providers live one-per-file in this folder and are merged with
 * runtime overrides from `bitacode.jsonc`.
 */
import { getRuntimeConfig } from '../runtime-config.js';
import { anthropicProvider } from './anthropic.js';
import { googleProvider } from './google.js';
import { openaiProvider } from './openai.js';
import { openrouterProvider } from './openrouter.js';
export const BUILTIN_PROVIDERS = [
    openaiProvider,
    anthropicProvider,
    googleProvider,
    openrouterProvider,
];
function sanitizeDefaultParams(defaultParams) {
    if (!defaultParams || Object.keys(defaultParams).length === 0)
        return undefined;
    return defaultParams;
}
function toProviderMap(providers) {
    return new Map(providers.map((provider) => [provider.id, provider]));
}
function mergeModelLists(baseModels, overrideModels) {
    const merged = new Map(baseModels.map((model) => [model.id, model]));
    for (const [modelId, override] of Object.entries(overrideModels || {})) {
        const current = merged.get(modelId);
        merged.set(modelId, {
            id: modelId,
            name: override.name ?? current?.name ?? modelId,
            contextWindow: override.contextWindow ?? current?.contextWindow ?? 0,
            pricingPerMillionInput: override.inputPricePerMillion ?? current?.pricingPerMillionInput ?? 0,
            pricingPerMillionOutput: override.outputPricePerMillion ?? current?.pricingPerMillionOutput ?? 0,
            pricingPerMillionCached: override.cachedPricePerMillion ?? current?.pricingPerMillionCached,
            defaultParams: sanitizeDefaultParams({
                ...(current?.defaultParams || {}),
                ...(override.defaultParams || {}),
            }),
        });
    }
    return Array.from(merged.values());
}
export function getAllProviders() {
    const runtimeProviders = getRuntimeConfig().providers || {};
    const mergedProviders = toProviderMap(BUILTIN_PROVIDERS);
    for (const [providerId, providerConfig] of Object.entries(runtimeProviders)) {
        const current = mergedProviders.get(providerId);
        mergedProviders.set(providerId, {
            id: providerId,
            name: providerConfig.name ?? current?.name ?? providerId,
            baseURL: providerConfig.baseURL ?? current?.baseURL,
            apiKey: providerConfig.apiKey ?? current?.apiKey,
            apiKeyEnvVar: providerConfig.apiKeyEnvVar ?? current?.apiKeyEnvVar,
            headers: providerConfig.headers ?? current?.headers,
            defaultParams: sanitizeDefaultParams({
                ...(current?.defaultParams || {}),
                ...(providerConfig.defaultParams || {}),
            }),
            models: mergeModelLists(current?.models || [], providerConfig.models),
        });
    }
    return Array.from(mergedProviders.values());
}
export function getProvider(providerId) {
    return getAllProviders().find((provider) => provider.id === providerId);
}
export function getModelDetails(providerId, modelId) {
    return getProvider(providerId)?.models.find((model) => model.id === modelId);
}
export function getModelPricing(providerId, modelId) {
    const details = getModelDetails(providerId, modelId);
    if (!details)
        return undefined;
    return {
        inputPerToken: details.pricingPerMillionInput / 1_000_000,
        outputPerToken: details.pricingPerMillionOutput / 1_000_000,
        cachedPerToken: details.pricingPerMillionCached != null ? details.pricingPerMillionCached / 1_000_000 : undefined,
        contextWindow: details.contextWindow,
    };
}
export function getRequestDefaultParams(providerId, modelId) {
    const provider = getProvider(providerId);
    const model = getModelDetails(providerId, modelId);
    return {
        ...(provider?.defaultParams || {}),
        ...(model?.defaultParams || {}),
    };
}

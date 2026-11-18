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
import type { ModelDetails, ModelProvider } from './types.js';

export type { ModelDetails, ModelProvider } from './types.js';

export const BUILTIN_PROVIDERS: ModelProvider[] = [
  openaiProvider,
  anthropicProvider,
  googleProvider,
  openrouterProvider,
];

const BUILTIN_ORDER = new Map(BUILTIN_PROVIDERS.map((provider, index) => [provider.id, index]));

/**
 * API-key env var aliases by provider id. Covers user-defined providers that
 * reuse a built-in id without declaring their own aliases.
 */
const KEY_ENV_ALIASES: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/**
 * Params only some provider families accept. A param listed here is sent only
 * to the matching provider ids; every other param is OpenAI-compatible.
 */
const PROVIDER_SCOPED_PARAMS: Record<string, ReadonlySet<string>> = {
  reasoning: new Set(['openrouter']),
  extra_body: new Set(['openrouter', 'google', 'gemini']),
  provider: new Set(['openrouter']),
  transforms: new Set(['openrouter']),
  generationConfig: new Set(['google', 'gemini']),
  safetySettings: new Set(['google', 'gemini']),
  thinking: new Set(['anthropic']),
  top_k: new Set(['anthropic', 'google', 'gemini']),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeDefaultParams(defaultParams?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isPlainObject(defaultParams) || Object.keys(defaultParams).length === 0) return undefined;
  return { ...defaultParams };
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBaseURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return value.trim();
  } catch {
    return undefined;
  }
}

function toProviderMap(providers: ModelProvider[]): Map<string, ModelProvider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function mergeModelLists(baseModels: ModelDetails[], overrideModels?: Record<string, any>): ModelDetails[] {
  const merged = new Map<string, ModelDetails>(
    baseModels.filter((model) => Boolean(model?.id)).map((model) => [model.id, model])
  );
  if (!isPlainObject(overrideModels)) return Array.from(merged.values());

  for (const [rawModelId, override] of Object.entries(overrideModels)) {
    const modelId = rawModelId.trim();
    if (!modelId) continue;
    const current = merged.get(modelId);
    const config = isPlainObject(override) ? override : {};
    const cached = safeNumber(config.cachedPricePerMillion ?? current?.pricingPerMillionCached, NaN);
    merged.set(modelId, {
      id: modelId,
      name: typeof config.name === 'string' && config.name.trim() ? config.name : (current?.name ?? modelId),
      contextWindow: safeNumber(config.contextWindow ?? current?.contextWindow, 0),
      pricingPerMillionInput: safeNumber(config.inputPricePerMillion ?? current?.pricingPerMillionInput, 0),
      pricingPerMillionOutput: safeNumber(config.outputPricePerMillion ?? current?.pricingPerMillionOutput, 0),
      ...(Number.isFinite(cached) ? { pricingPerMillionCached: cached } : {}),
      defaultParams: sanitizeDefaultParams({
        ...(current?.defaultParams || {}),
        ...(config.defaultParams || {}),
      }),
    });
  }
  return Array.from(merged.values());
}

export function getAllProviders(): ModelProvider[] {
  const runtimeProviders = getRuntimeConfig().providers || {};
  const mergedProviders = toProviderMap(BUILTIN_PROVIDERS);

  // Sort keys so trimmed-id collisions resolve deterministically (last wins).
  const entries = Object.entries(runtimeProviders).sort(([a], [b]) => a.localeCompare(b));
  for (const [rawProviderId, rawConfig] of entries) {
    const providerId = rawProviderId.trim();
    if (!providerId || !isPlainObject(rawConfig)) continue;

    const current = mergedProviders.get(providerId);
    const models = mergeModelLists(current?.models || [], rawConfig.models as Record<string, any>);
    // A provider without models is unusable; a built-in override keeps its
    // inherited models, so only genuinely empty providers are dropped.
    if (models.length === 0) continue;

    const configuredBaseURL = rawConfig.baseURL;
    // An invalid override is normalized away rather than crashing the SDK;
    // built-in providers keep their known-good URL in that case.
    const baseURL = configuredBaseURL === undefined
      ? current?.baseURL
      : (normalizeBaseURL(configuredBaseURL) ?? current?.baseURL);

    mergedProviders.set(providerId, {
      id: providerId,
      name: typeof rawConfig.name === 'string' && rawConfig.name.trim() ? rawConfig.name : (current?.name ?? providerId),
      baseURL,
      apiKey: (typeof rawConfig.apiKey === 'string' ? rawConfig.apiKey : undefined) ?? current?.apiKey,
      apiKeyEnvVar: (typeof rawConfig.apiKeyEnvVar === 'string' ? rawConfig.apiKeyEnvVar : undefined) ?? current?.apiKeyEnvVar,
      keyEnvVars: Array.from(new Set([
        ...(current?.keyEnvVars || []),
        ...(Array.isArray(rawConfig.keyEnvVars) ? rawConfig.keyEnvVars.filter((v): v is string => typeof v === 'string') : []),
      ])),
      headers: isPlainObject(rawConfig.headers) ? (rawConfig.headers as Record<string, string>) : current?.headers,
      defaultParams: sanitizeDefaultParams({
        ...(current?.defaultParams || {}),
        ...(isPlainObject(rawConfig.defaultParams) ? rawConfig.defaultParams : {}),
      }),
      models,
    });
  }

  // Deterministic ordering: built-ins keep their curated priority (the setup
  // wizard relies on openai being first); custom providers sort by id.
  return Array.from(mergedProviders.values()).sort((a, b) => {
    const ai = BUILTIN_ORDER.get(a.id);
    const bi = BUILTIN_ORDER.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
}

export function getProvider(providerId: string): ModelProvider | undefined {
  return getAllProviders().find((provider) => provider.id === providerId);
}

export function getModelDetails(providerId: string, modelId: string): ModelDetails | undefined {
  return getProvider(providerId)?.models.find((model) => model.id === modelId);
}

export function getModelPricing(providerId: string, modelId: string) {
  const details = getModelDetails(providerId, modelId);
  if (!details) return undefined;
  return {
    inputPerToken: details.pricingPerMillionInput / 1_000_000,
    outputPerToken: details.pricingPerMillionOutput / 1_000_000,
    cachedPerToken: Number.isFinite(details.pricingPerMillionCached) ? details.pricingPerMillionCached! / 1_000_000 : undefined,
    contextWindow: details.contextWindow,
  };
}

/** All env var names that can supply this provider's API key, in priority order. */
export function getProviderApiKeyEnvVars(providerId: string): string[] {
  const provider = getProvider(providerId);
  return Array.from(new Set([
    ...(provider?.apiKeyEnvVar ? [provider.apiKeyEnvVar] : []),
    ...(provider?.keyEnvVars || []),
    ...(KEY_ENV_ALIASES[providerId] || []),
  ]));
}

export function getRequestDefaultParams(providerId: string, modelId: string): Record<string, unknown> {
  const provider = getProvider(providerId);
  const model = getModelDetails(providerId, modelId);
  const merged = {
    ...(provider?.defaultParams || {}),
    ...(model?.defaultParams || {}),
  };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    const allowedProviders = PROVIDER_SCOPED_PARAMS[key];
    if (allowedProviders && !allowedProviders.has(providerId)) continue;
    result[key] = value;
  }
  return result;
}

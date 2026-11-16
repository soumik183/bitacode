import type { ModelProvider } from './types.js';

export const anthropicProvider: ModelProvider = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  baseURL: 'https://api.anthropic.com/v1/',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  models: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200_000, pricingPerMillionInput: 5.0, pricingPerMillionOutput: 25.0 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200_000, pricingPerMillionInput: 3.0, pricingPerMillionOutput: 15.0 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, pricingPerMillionInput: 1.0, pricingPerMillionOutput: 5.0 },
  ],
};

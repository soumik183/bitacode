import type { ModelProvider } from './types.js';

/**
 * OpenRouter exposes an OpenAI-compatible API. Model IDs are namespaced
 * (`vendor/model`), so add any extra models you need through
 * `bitacode.jsonc` under providers.openrouter.models.
 */
export const openrouterProvider: ModelProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  headers: {
    'X-Title': 'Bitacode',
  },
  models: [
    { id: 'openai/gpt-4o', name: 'GPT-4o', contextWindow: 128_000, pricingPerMillionInput: 2.50, pricingPerMillionOutput: 10.00 },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, pricingPerMillionInput: 3.0, pricingPerMillionOutput: 15.0 },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1_048_576, pricingPerMillionInput: 0.30, pricingPerMillionOutput: 2.50 },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', contextWindow: 163_840, pricingPerMillionInput: 0.27, pricingPerMillionOutput: 1.10 },
  ],
};

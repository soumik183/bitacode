export const googleProvider = {
    id: 'google',
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    models: [
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)', contextWindow: 1_000_000, pricingPerMillionInput: 0.50, pricingPerMillionOutput: 3.0 },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)', contextWindow: 1_000_000, pricingPerMillionInput: 2.0, pricingPerMillionOutput: 12.0 },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1_000_000, pricingPerMillionInput: 0.30, pricingPerMillionOutput: 2.5 },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1_000_000, pricingPerMillionInput: 1.25, pricingPerMillionOutput: 10.0 },
    ],
};

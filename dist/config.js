import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { Select, TextInput, PasswordInput } from '@inkjs/ui';
import { parse } from 'jsonc-parser';
import { getActiveRuntimeConfigPath, RuntimeConfigFileSchema } from './runtime-config.js';
import { getAllProviders, getProvider, getProviderApiKeyEnvVars } from './providers/index.js';
import { useTheme } from './theme.js';
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
function hardenPermissions(targetPath, mode) {
    if (process.platform === 'win32')
        return;
    chmodSync(targetPath, mode);
}
export function resolveApiKey(config) {
    const provider = getProvider(config.provider);
    // 1. Provider-specific environment variable and its common aliases
    for (const envVar of getProviderApiKeyEnvVars(config.provider)) {
        const providerEnvOverride = process.env[envVar]?.trim();
        if (providerEnvOverride) {
            return providerEnvOverride;
        }
    }
    // 2. Generic environment variable
    const envOverride = process.env.BITACODE_API_KEY?.trim();
    if (envOverride) {
        return envOverride;
    }
    // 3. Config file (either from selected provider or direct apiKey)
    const directApiKey = config.apiKey?.trim();
    if (directApiKey) {
        return directApiKey;
    }
    const providerApiKey = provider?.apiKey?.trim();
    if (providerApiKey) {
        return providerApiKey;
    }
    // Fallback for Cloudflare Gateway or other custom header setups
    if (process.env.BITACODE_CUSTOM_HEADERS) {
        return 'none';
    }
    const headerNames = Object.keys(provider?.headers ?? {});
    const headersCarryAuth = provider?.apiKeyEnvVar
        ? headerNames.some((name) => /authorization|api[-_]?key|token/i.test(name))
        : headerNames.length > 0;
    return headersCarryAuth ? 'none' : null;
}
/**
 * Best-effort first-run autodetection: pick the first provider whose API key is
 * already in the environment so a configured shell skips the setup wizard.
 */
export function detectConfigFromEnvironment() {
    try {
        const providers = getAllProviders();
        // Common alias keys; copy the value into config so detection behavior is
        // unchanged even for callers that read config.apiKey directly.
        const commonEnvVars = {
            google: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
        };
        for (const provider of providers) {
            const envVars = [
                ...(provider.apiKeyEnvVar ? [provider.apiKeyEnvVar] : []),
                ...(commonEnvVars[provider.id] ?? []),
            ];
            for (const envVar of envVars) {
                const value = process.env[envVar]?.trim();
                if (!value)
                    continue;
                const model = provider.models[0];
                if (!model)
                    continue;
                const resolvedFromEnv = envVar === provider.apiKeyEnvVar || envVar === 'BITACODE_API_KEY';
                return {
                    provider: provider.id,
                    model: model.id,
                    ...(resolvedFromEnv ? {} : { apiKey: value }),
                };
            }
        }
        // Generic key only: it is ambiguous, so fall back to the first usable provider.
        if (process.env.BITACODE_API_KEY?.trim()) {
            for (const provider of providers) {
                const model = provider.models[0];
                if (model)
                    return { provider: provider.id, model: model.id };
            }
        }
    }
    catch {
        // Detection is optional; never break startup for an odd environment.
    }
    return null;
}
export const getConfigDirectory = () => {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Local', 'bitacode');
    }
    return path.join(homeDir, '.local', 'share', 'bitacode');
};
export const getUserRuntimeConfigDirectory = () => {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Local', 'bitacode');
    }
    return path.join(homeDir, '.config', 'bitacode');
};
export const getUserRuntimeConfigPath = () => {
    return path.join(getUserRuntimeConfigDirectory(), 'bitacode.jsonc');
};
/** Creates the shared config folder so first run never starts without it. */
export const ensureUserConfigDirectory = () => {
    const configDir = getUserRuntimeConfigDirectory();
    ensureDirectory(configDir);
    return configDir;
};
export const getProjectRuntimeConfigDirectory = (cwd = process.cwd()) => {
    return path.join(cwd, '.bitacode');
};
export const getProjectRuntimeConfigPath = (cwd = process.cwd()) => {
    return path.join(getProjectRuntimeConfigDirectory(cwd), 'bitacode.jsonc');
};
export const getRuntimeConfigPath = (target, cwd = process.cwd()) => {
    return target === 'project' ? getProjectRuntimeConfigPath(cwd) : getUserRuntimeConfigPath();
};
export const RUNTIME_CONFIG_TEMPLATE = `{
  // Add project or user-wide Bitacode runtime config here.
  // Example uses:
  // - choose the active provider/model by making it the first provider
  //   and the first model under that provider
  // - custom providers/models
  // - MCP server definitions
  // - request default parameters
  "providers": {
    // "provider-id": {
    //   "name": "Display Name",
    //   "baseURL": "https://api.example.com/v1",
    //   "apiKey": "your-api-key",
    //   "apiKeyEnvVar": "ENV_VAR_NAME",
    //   "headers": {
    //     "X-Custom-Header": "value"
    //   },
    //   "defaultParams": {},
    //   "models": {
    //     "model-id": {
    //       "name": "Display Name",
    //       "contextWindow": 128000,
    //       "inputPricePerMillion": 2.5,
    //       "outputPricePerMillion": 10.0,
    //       "cachedPricePerMillion": 1.25,
    //       "defaultParams": {}
    //     }
    //   }
    // }
  },
  "mcp": {
    "servers": {
      // "server-name": {
      //   "type": "stdio",
      //   "command": "npx",
      //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      //   "env": { "KEY": "value" },
      //   "cwd": "/working/directory",
      //   "enabled": true,
      //   "timeoutMs": 30000
      // },
      // "http-server": {
      //   "type": "http",
      //   "url": "https://mcp-server.example.com",
      //   "headers": { "Authorization": "Bearer token" },
      //   "enabled": true,
      //   "timeoutMs": 30000
      // }
    }
  }
}
`;
function ensureDirectory(targetDir) {
    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true, mode: CONFIG_DIR_MODE });
    }
    hardenPermissions(targetDir, CONFIG_DIR_MODE);
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function readRuntimeConfigFileSync(configPath) {
    if (!existsSync(configPath)) {
        return null;
    }
    try {
        const content = readFileSync(configPath, 'utf8');
        const errors = [];
        const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length > 0 || !isPlainObject(parsed)) {
            return null;
        }
        // Validate against zod schema
        const result = RuntimeConfigFileSchema.safeParse(parsed);
        if (!result.success) {
            console.error('Invalid runtime config format:', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', '));
            return null;
        }
        return result.data;
    }
    catch (error) {
        console.error('Error reading runtime config file:', error);
        return null;
    }
}
// Returns the first provider with a valid model from the runtime config.
// The active provider/model is determined by order: first provider in the
// config with at least one model, and the first model under that provider.
function getConfiguredProviderAndModel(runtimeConfig) {
    for (const [providerId, providerConfig] of Object.entries(runtimeConfig.providers || {})) {
        const modelId = Object.keys(providerConfig.models || {})[0];
        if (!modelId)
            continue;
        const apiKey = typeof providerConfig.apiKey === 'string' && providerConfig.apiKey.trim().length > 0
            ? providerConfig.apiKey.trim()
            : undefined;
        return {
            provider: providerId,
            model: modelId,
            ...(apiKey ? { apiKey } : {}),
        };
    }
    return null;
}
function writeRuntimeConfigFile(configPath, runtimeConfig) {
    ensureDirectory(path.dirname(configPath));
    writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    hardenPermissions(configPath, CONFIG_FILE_MODE);
}
// Merges a new provider/model configuration into the existing runtime config.
// Used by writeConfig() to add/update a provider without losing existing data.
// - newConfig: the provider/model to add (from user running 'configure' command)
// - existingRuntimeConfig: the current runtime config file content (may be empty)
function upsertSelectedConfig(existingRuntimeConfig, newConfig) {
    const existingProviders = existingRuntimeConfig.providers || {};
    const currentProvider = existingProviders[newConfig.provider] || {};
    const currentModels = currentProvider.models || {};
    const selectedModelConfig = currentModels[newConfig.model] || {};
    const nextProvider = {
        ...currentProvider,
        ...(newConfig.apiKey?.trim() ? { apiKey: newConfig.apiKey.trim() } : {}),
        models: Object.fromEntries([
            [newConfig.model, selectedModelConfig],
            ...Object.entries(currentModels).filter(([modelId]) => modelId !== newConfig.model),
        ]),
    };
    if (!newConfig.apiKey?.trim()) {
        delete nextProvider.apiKey;
    }
    return {
        ...existingRuntimeConfig,
        providers: Object.fromEntries([
            [newConfig.provider, nextProvider],
            ...Object.entries(existingProviders).filter(([providerId]) => providerId !== newConfig.provider),
        ]),
    };
}
export function writeInitConfig(target, cwd = process.cwd(), options = {}) {
    const configPath = getRuntimeConfigPath(target, cwd);
    const alreadyExists = existsSync(configPath);
    if (alreadyExists) {
        if (!options.overwrite) {
            return { path: configPath, status: 'exists' };
        }
    }
    else {
        ensureDirectory(path.dirname(configPath));
    }
    writeFileSync(configPath, RUNTIME_CONFIG_TEMPLATE, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    hardenPermissions(configPath, CONFIG_FILE_MODE);
    return { path: configPath, status: alreadyExists ? 'overwritten' : 'created' };
}
// Reads the provider/model config from a runtime config file.
// - 'project': read from <cwd>/.bitacode/bitacode.jsonc
// - 'user': read from ~/.config/bitacode/bitacode.jsonc
// - 'active' (default): check project config first, fall back to user config
//   This is what the agent uses at runtime to determine which provider/model to use.
export const readConfig = (target = 'active', cwd = process.cwd()) => {
    const configPath = target === 'active' ? getActiveRuntimeConfigPath() : getRuntimeConfigPath(target, cwd);
    if (!configPath) {
        return null;
    }
    const runtimeConfig = readRuntimeConfigFileSync(configPath);
    if (!runtimeConfig) {
        return null;
    }
    return getConfiguredProviderAndModel(runtimeConfig);
};
export const writeConfig = (config, target = 'user', cwd = process.cwd()) => {
    const configPath = getRuntimeConfigPath(target, cwd);
    const runtimeConfig = readRuntimeConfigFileSync(configPath) || { providers: {}, mcp: { servers: {} } };
    const nextRuntimeConfig = upsertSelectedConfig(runtimeConfig, config);
    writeRuntimeConfigFile(configPath, nextRuntimeConfig);
    return configPath;
};
// Stores a provider's key without changing which provider/model starts next.
export const writeProviderApiKey = (providerId, apiKey, target = 'user', cwd = process.cwd()) => {
    const configPath = getRuntimeConfigPath(target, cwd);
    const runtimeConfig = readRuntimeConfigFileSync(configPath) || { providers: {}, mcp: { servers: {} } };
    const providerConfig = runtimeConfig.providers?.[providerId] || {};
    writeRuntimeConfigFile(configPath, {
        ...runtimeConfig,
        providers: {
            ...(runtimeConfig.providers || {}),
            [providerId]: { ...providerConfig, apiKey: apiKey.trim() },
        },
    });
    return configPath;
};
// Moves a provider/model to the front of the config so it is the active
// selection on the next launch. Keys and other providers are preserved.
export const writeActiveSelection = (providerId, modelId, target = 'user', cwd = process.cwd(), modelInfo = {}) => {
    if (!providerId.trim() || !modelId.trim()) {
        throw new Error('Provider and model are required.');
    }
    const configPath = getRuntimeConfigPath(target, cwd);
    const runtimeConfig = readRuntimeConfigFileSync(configPath) || { providers: {}, mcp: { servers: {} } };
    const providers = runtimeConfig.providers || {};
    const provider = providers[providerId] || {};
    const models = provider.models || {};
    const currentModel = models[modelId] ?? {};
    const nextModel = {
        ...currentModel,
        ...(currentModel.name ? {} : modelInfo.name ? { name: modelInfo.name } : {}),
        ...(currentModel.contextWindow == null && modelInfo.contextWindow
            ? { contextWindow: modelInfo.contextWindow }
            : {}),
    };
    const nextProvider = {
        ...provider,
        models: Object.fromEntries([
            [modelId, nextModel],
            ...Object.entries(models).filter(([id]) => id !== modelId),
        ]),
    };
    writeRuntimeConfigFile(configPath, {
        ...runtimeConfig,
        providers: {
            [providerId]: nextProvider,
            ...Object.fromEntries(Object.entries(providers).filter(([id]) => id !== providerId)),
        },
    });
    return configPath;
};
export const ResetPrompt = ({ existingConfig, setStep, setConfigWritten }) => {
    const provider = getProvider(existingConfig.provider);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: "Existing configuration found:" }), _jsxs(Text, { children: ["  Provider: ", provider?.name || existingConfig.provider] }), _jsxs(Text, { children: ["  Model: ", existingConfig.model] }), _jsxs(Text, { children: ["  API Key: ", '*'.repeat(8)] }), _jsx(Text, { children: " " }), _jsx(Text, { children: "Do you want to reset and configure a new one? (y/n)" }), _jsx(TextInput, { onSubmit: (answer) => {
                    if (answer.toLowerCase() === 'y') {
                        setStep(2);
                    }
                    else {
                        setConfigWritten(false);
                        setStep(4);
                    }
                } })] }));
};
export const TargetSelection = ({ title, subtitle, onSelect, }) => {
    const theme = useTheme();
    return (_jsxs(Box, { flexDirection: "column", children: [title && _jsx(Text, { color: theme.text, bold: true, children: title }), subtitle && _jsx(Text, { children: subtitle }), _jsx(Box, { marginTop: 1, children: _jsx(Select, { options: [
                        { label: `Project config — ${getProjectRuntimeConfigPath()}`, value: 'project' },
                        { label: `Shared user config — ${getUserRuntimeConfigPath()}`, value: 'user' },
                    ], onChange: (value) => onSelect(value) }) })] }));
};
export const ModelSelection = ({ setSelectedProviderId, setSelectedModelId, onSelect, setStep, title, subtitle, }) => {
    const theme = useTheme();
    const items = getAllProviders().flatMap((provider) => provider.models.map((model) => ({
        label: `${provider.name} - ${model.name}`,
        value: `${provider.id}:::${model.id}`,
    })));
    const handleSelect = (value) => {
        const [providerId, modelId] = value.split(':::');
        setSelectedProviderId(providerId);
        setSelectedModelId(modelId);
        if (onSelect) {
            onSelect(providerId, modelId);
        }
        else {
            setStep?.(3);
        }
    };
    return (_jsxs(Box, { flexDirection: "column", children: [title && _jsx(Text, { color: theme.text, bold: true, children: title }), subtitle && _jsx(Text, { color: theme.muted, children: subtitle }), _jsx(Text, { children: "Select an AI Model:" }), _jsx(Select, { options: items, onChange: handleSelect })] }));
};
export const ApiKeyInput = ({ selectedProviderId, selectedModelId, target = 'user', title, showProviderHeaders = true, onComplete, setStep, setConfigWritten, }) => {
    const theme = useTheme();
    const [errorMessage, setErrorMessage] = useState('');
    const provider = getProvider(selectedProviderId);
    const canUseResolvedAuth = Boolean(resolveApiKey({ provider: selectedProviderId, apiKey: undefined }));
    const handleApiKeySubmit = (value) => {
        if (value.trim().length === 0 && !canUseResolvedAuth) {
            setErrorMessage('API key cannot be empty.');
            return;
        }
        const newConfig = {
            provider: selectedProviderId,
            model: selectedModelId,
            ...(value.trim().length > 0 ? { apiKey: value.trim() } : {}),
        };
        writeConfig(newConfig, target);
        if (onComplete) {
            onComplete(newConfig);
        }
        else {
            setConfigWritten?.(true);
            setStep?.(4);
        }
    };
    return (_jsxs(Box, { flexDirection: "column", children: [title && _jsx(Text, { color: theme.text, bold: true, children: title }), _jsxs(Text, { children: [canUseResolvedAuth ? 'Optional API Key' : 'Enter API Key', " for ", provider?.name || selectedProviderId, ":"] }), showProviderHeaders && provider?.headers && Object.keys(provider.headers).length > 0 && (_jsx(Text, { dimColor: true, children: "This provider can authenticate with configured headers or environment variables." })), errorMessage && _jsx(Text, { color: theme.error, children: errorMessage }), _jsx(PasswordInput, { placeholder: canUseResolvedAuth ? 'Press enter to keep resolved auth' : `Enter your ${provider?.apiKeyEnvVar || 'API'} key`, onSubmit: handleApiKeySubmit })] }));
};
export const ConfigResult = ({ configWritten }) => {
    const theme = useTheme();
    return (_jsxs(Box, { flexDirection: "column", children: [configWritten ? (_jsx(Text, { color: theme.text, children: "Configuration saved successfully!" })) : (_jsx(Text, { color: theme.muted, children: "Configuration not changed." })), _jsx(Text, { children: "You can now run Bitacode." })] }));
};
export const ConfigureComponent = ({ onComplete } = {}) => {
    // Global (user) config only — no target question. Setup is always:
    // provider + model → API key → done.
    const [step, setStep] = useState(2);
    const [target] = useState('user');
    const [selectedProviderId, setSelectedProviderId] = useState('');
    const [selectedModelId, setSelectedModelId] = useState('');
    const [configWritten, setConfigWritten] = useState(false);
    switch (step) {
        case 2:
            return (_jsx(ModelSelection, { setSelectedProviderId: setSelectedProviderId, setSelectedModelId: setSelectedModelId, setStep: setStep, title: "Configure Bitacode", subtitle: `Saving to ${getUserRuntimeConfigPath()}` }));
        case 3:
            return (_jsx(ApiKeyInput, { selectedProviderId: selectedProviderId, selectedModelId: selectedModelId, target: target, onComplete: onComplete, setStep: setStep, setConfigWritten: setConfigWritten }));
        case 4:
            return _jsx(ConfigResult, { configWritten: configWritten });
        default:
            return _jsx(Text, { children: "Unknown step." });
    }
};
export const InitComponent = () => {
    const theme = useTheme();
    const [selectedTarget, setSelectedTarget] = useState(null);
    const [result, setResult] = useState(null);
    // Step 1: Show target selection
    if (!selectedTarget && !result) {
        return (_jsx(TargetSelection, { title: "Create a Bitacode runtime config", subtitle: "Select where to write `bitacode.jsonc`", onSelect: (target) => {
                const configPath = getRuntimeConfigPath(target);
                if (existsSync(configPath)) {
                    setSelectedTarget(target);
                    return;
                }
                setResult(writeInitConfig(target));
            } }));
    }
    // Step 2: Target selected but file exists - confirm overwrite
    if (selectedTarget && !result) {
        const selectedPath = getRuntimeConfigPath(selectedTarget);
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: "Config already exists:" }), _jsx(Text, { children: selectedPath }), _jsx(Text, { children: "Overwrite it? (y/n)" }), _jsx(TextInput, { onSubmit: (answer) => {
                        if (answer.trim().toLowerCase() === 'y') {
                            setResult(writeInitConfig(selectedTarget, process.cwd(), { overwrite: true }));
                        }
                        else {
                            setResult({ path: selectedPath, status: 'exists' });
                        }
                    } })] }));
    }
    // Step 3: Show result
    if (result) {
        const color = result.status === 'exists' ? theme.muted : theme.text;
        const message = result.status === 'created'
            ? 'Created Bitacode config:'
            : result.status === 'overwritten'
                ? 'Overwrote Bitacode config:'
                : 'Bitacode config already exists:';
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: color, children: message }), _jsx(Text, { children: result.path })] }));
    }
    return null;
};

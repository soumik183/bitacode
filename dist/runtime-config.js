import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { mergeLocalPresets } from './providers/local-presets.js';
// ─── Zod Schemas for Runtime Validation ───
export const RuntimeModelConfigSchema = z.object({
    name: z.string().optional(),
    contextWindow: z.number().optional(),
    inputPricePerMillion: z.number().optional(),
    outputPricePerMillion: z.number().optional(),
    cachedPricePerMillion: z.number().optional(),
    defaultParams: z.record(z.string(), z.unknown()).optional(),
});
export const RuntimeProviderConfigSchema = z.object({
    name: z.string().optional(),
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyEnvVar: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    defaultParams: z.record(z.string(), z.unknown()).optional(),
    models: z.record(z.string(), RuntimeModelConfigSchema).optional(),
});
export const StdioServerConfigSchema = z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().optional(),
});
export const HttpServerConfigSchema = z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().optional(),
});
export const RuntimeMcpServerConfigSchema = z.union([StdioServerConfigSchema, HttpServerConfigSchema]);
export const RuntimeConfigFileSchema = z.object({
    // Explicit active selection. Older configs encoded the choice implicitly by
    // key order; both are read, but only this survives a reorder or a rewrite.
    provider: z.string().optional(),
    model: z.string().optional(),
    providers: z.record(z.string(), z.any()).optional(),
    /** Optional provider/model policy: { allowedModels, deniedModels, maxRetries }. */
    providerPolicy: z.unknown().optional(),
    mcp: z.object({
        servers: z.record(z.string(), z.any()).optional(),
    }).optional(),
});
const RESERVED_DEFAULT_PARAM_KEYS = new Set([
    'model',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'stream_options',
]);
const DEFAULT_RUNTIME_CONFIG = {
    providers: {},
    mcp: { servers: {} },
};
let runtimeConfigCache = null;
function getProjectRuntimeConfigPath() {
    return path.join(process.cwd(), '.bitacode', 'bitacode.jsonc');
}
function getUserRuntimeConfigPath() {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Local', 'bitacode', 'bitacode.jsonc');
    }
    return path.join(homeDir, '.config', 'bitacode', 'bitacode.jsonc');
}
export function getActiveRuntimeConfigPath() {
    const projectPath = getProjectRuntimeConfigPath();
    if (existsSync(projectPath)) {
        return projectPath;
    }
    const userPath = getUserRuntimeConfigPath();
    if (existsSync(userPath)) {
        return userPath;
    }
    return null;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Replaces ${ENV_VAR} placeholders in a string with actual environment variable values.
 * Logs a warning if the environment variable is not set (replaces with empty string).
 */
function interpolateString(value, sourcePath) {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, envVar) => {
        const resolved = process.env[envVar];
        if (resolved === undefined) {
            logger.warn(`Missing environment variable ${envVar} while loading ${sourcePath}`);
            return '';
        }
        return resolved;
    });
}
/**
 * Recursively interpolates environment variables in all string values within a config object.
 * Handles nested objects and arrays. Filters out empty header values.
 */
function interpolateValue(value, sourcePath) {
    if (typeof value === 'string') {
        return interpolateString(value, sourcePath);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => interpolateValue(entry, sourcePath));
    }
    if (isPlainObject(value)) {
        const next = {};
        for (const [key, entry] of Object.entries(value)) {
            const interpolated = interpolateValue(entry, sourcePath);
            if (key === 'headers' && isPlainObject(interpolated)) {
                // Filter out headers with empty values (from unset env vars)
                const filtered = Object.fromEntries(Object.entries(interpolated).filter(([, headerValue]) => typeof headerValue !== 'string' || headerValue.length > 0));
                next[key] = filtered;
                continue;
            }
            next[key] = interpolated;
        }
        return next;
    }
    return value;
}
/**
 * Removes reserved API parameters from provider and model defaultParams.
 * Prevents users from accidentally overriding critical parameters like
 * 'model', 'messages', 'tools' that are managed by the agentic loop.
 */
function sanitizeDefaultParamsInConfig(config) {
    const nextProviders = Object.fromEntries(Object.entries(config.providers || {}).map(([providerId, provider]) => {
        const providerDefaultParams = Object.fromEntries(Object.entries(provider.defaultParams || {}).filter(([key]) => {
            const allowed = !RESERVED_DEFAULT_PARAM_KEYS.has(key);
            if (!allowed) {
                logger.warn(`Ignoring reserved provider default param '${key}' for provider ${providerId}`);
            }
            return allowed;
        }));
        const nextModels = Object.fromEntries(Object.entries(provider.models || {}).map(([modelId, model]) => {
            const modelDefaultParams = Object.fromEntries(Object.entries(model.defaultParams || {}).filter(([key]) => {
                const allowed = !RESERVED_DEFAULT_PARAM_KEYS.has(key);
                if (!allowed) {
                    logger.warn(`Ignoring reserved model default param '${key}' for model ${providerId}/${modelId}`);
                }
                return allowed;
            }));
            return [
                modelId,
                {
                    ...model,
                    ...(Object.keys(modelDefaultParams).length > 0 ? { defaultParams: modelDefaultParams } : {}),
                },
            ];
        }));
        return [
            providerId,
            {
                ...provider,
                ...(Object.keys(providerDefaultParams).length > 0 ? { defaultParams: providerDefaultParams } : {}),
                models: nextModels,
            },
        ];
    }));
    return {
        ...config,
        providers: nextProviders,
    };
}
async function readRuntimeConfigFile(configPath) {
    try {
        const content = await fs.readFile(configPath, 'utf8');
        const errors = [];
        const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length > 0) {
            const details = errors
                .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
                .join(', ');
            throw new Error(`Failed to parse ${configPath}: ${details}`);
        }
        if (!isPlainObject(parsed)) {
            throw new Error(`Failed to parse ${configPath}: top-level value must be an object`);
        }
        // Validate against zod schema for better error messages
        const result = RuntimeConfigFileSchema.safeParse(parsed);
        if (!result.success) {
            const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
            throw new Error(`Invalid runtime config in ${configPath}: ${issues}`);
        }
        return sanitizeDefaultParamsInConfig(interpolateValue(result.data, configPath));
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
export async function loadRuntimeConfig(forceReload = false) {
    if (!forceReload && runtimeConfigCache) {
        return runtimeConfigCache;
    }
    const configPath = getActiveRuntimeConfigPath();
    let loaded = DEFAULT_RUNTIME_CONFIG;
    if (configPath) {
        const fileConfig = await readRuntimeConfigFile(configPath);
        if (fileConfig) {
            logger.debug('Loaded runtime config', { path: configPath });
            loaded = fileConfig;
        }
    }
    // Local servers are config-only presets: user/project definitions always win.
    // mergeLocalPresets never throws, so a bad preset cannot break startup.
    const providersWithPresets = mergeLocalPresets(loaded.providers ?? {});
    const resolved = {
        ...loaded,
        providers: providersWithPresets,
    };
    runtimeConfigCache = resolved;
    return resolved;
}
export function getRuntimeConfig() {
    return runtimeConfigCache || DEFAULT_RUNTIME_CONFIG;
}
export function resetRuntimeConfigForTests() {
    runtimeConfigCache = null;
}

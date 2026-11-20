/**
 * client.ts — the one place that turns config into an OpenAI-compatible client.
 *
 * Extracted from App.tsx so the TUI and headless mode cannot drift: base URL,
 * header overrides, API-key resolution and provider defaults are decided here and
 * nowhere else.
 */

import OpenAI from 'openai';
import type { Config } from '../config.js';
import { resolveApiKey } from '../config.js';
import { getProvider } from './index.js';

export interface ClientOverrides {
  /** Explicit key, e.g. freshly entered in the wizard. */
  apiKey?: string;
  /** Explicit base URL, used by `--base-url`. */
  baseUrl?: string;
}

/** Parse `Key: value` lines from BITACODE_CUSTOM_HEADERS. */
export function parseCustomHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/**
 * Build a client for the configured provider.
 *
 * Throws with an actionable message when no API key exists: that is the only
 * failure the user can fix, so it must name the provider and the env var.
 */
export function createProviderClient(config: Pick<Config, 'provider' | 'model'> & { apiKey?: string }, overrides: ClientOverrides = {}): OpenAI {
  const provider = getProvider(config.provider);
  const apiKey = overrides.apiKey?.trim() || resolveApiKey(config);

  if (!apiKey) {
    const providerName = provider?.name || config.provider;
    const envVar = provider?.apiKeyEnvVar;
    throw new Error(
      envVar
        ? `Missing API key for ${providerName}. Set it in config or export ${envVar}.`
        : `Missing API key for ${providerName}.`
    );
  }

  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };

  const baseURL = overrides.baseUrl?.trim() || process.env.BITACODE_BASE_URL?.trim() || provider?.baseURL;
  if (baseURL) clientOptions.baseURL = baseURL;

  const customHeaders = parseCustomHeaders(process.env.BITACODE_CUSTOM_HEADERS);
  if (Object.keys(customHeaders).length > 0) {
    clientOptions.defaultHeaders = customHeaders;
  } else if (provider?.headers && Object.keys(provider.headers).length > 0) {
    clientOptions.defaultHeaders = provider.headers;
  }

  return new OpenAI(clientOptions);
}

/** Provider/model pair resolved for display and diagnostics. */
export function describeRoute(config: Pick<Config, 'provider' | 'model'>, overrides: ClientOverrides = {}): string {
  const provider = getProvider(config.provider);
  const base = overrides.baseUrl?.trim() || process.env.BITACODE_BASE_URL?.trim() || provider?.baseURL;
  const name = provider?.name ?? config.provider;
  return base ? `${name}/${config.model} (${base})` : `${name}/${config.model}`;
}

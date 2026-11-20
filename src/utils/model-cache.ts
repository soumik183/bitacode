/**
 * On-disk cache of live provider model lists.
 *
 * Fetching `/models` from a cold provider can take seconds (or hang until the
 * timeout). The list barely changes, so it is cached per provider + base URL and
 * shown instantly on the next launch while a refresh happens in the background.
 *
 * Lives at `~/.local/share/bitacode/model-cache.json` (or `$XDG_DATA_HOME`).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

export interface CachedModel {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
}

export interface ModelCacheEntry {
  items: CachedModel[];
  fetchedAt: number;
}

/** How long a cached list is served without touching the network. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
/** Entries older than this are dropped on the next write. */
export const MODEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const CACHE_FILE = 'model-cache.json';

function getDataDirectory(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode');
}

export function getModelCachePath(): string {
  return path.join(getDataDirectory(), CACHE_FILE);
}

function cacheKey(providerId: string, baseURL?: string): string {
  return `${providerId.trim()}::${(baseURL ?? '').trim()}`;
}

/** Read the whole cache file. A corrupt file is ignored, never fatal. */
async function readCacheFile(): Promise<Record<string, ModelCacheEntry>> {
  try {
    const raw = await fs.readFile(getModelCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ModelCacheEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
      const items = Array.isArray(value?.items) ? value.items : [];
      const fetchedAt = Number(value?.fetchedAt ?? 0);
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) continue;
      result[key] = { fetchedAt, items: items.filter((item: any) => typeof item?.id === 'string' && item.id) };
    }
    return result;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.warn('Could not read the model cache', { error: error?.message });
    }
    return {};
  }
}

/**
 * Cached model list for a provider, or null when nothing usable is stored.
 * `stale` is true when the entry is older than the TTL, meaning the caller
 * should refresh it when convenient.
 */
export async function readModelCache(
  providerId: string,
  baseURL?: string,
  now = Date.now()
): Promise<{ items: CachedModel[]; fetchedAt: number; ageMs: number; stale: boolean } | null> {
  const cache = await readCacheFile();
  const entry = cache[cacheKey(providerId, baseURL)];
  if (!entry || entry.items.length === 0) return null;
  const ageMs = Math.max(0, now - entry.fetchedAt);
  return { items: entry.items, fetchedAt: entry.fetchedAt, ageMs, stale: ageMs > MODEL_CACHE_TTL_MS };
}

/** Store a provider's model list, pruning entries that are far too old. */
export async function writeModelCache(
  providerId: string,
  baseURL: string | undefined,
  items: CachedModel[],
  now = Date.now()
): Promise<void> {
  if (items.length === 0) return;
  try {
    const cache = await readCacheFile();
    cache[cacheKey(providerId, baseURL)] = { items, fetchedAt: now };
    for (const [key, entry] of Object.entries(cache)) {
      if (now - entry.fetchedAt > MODEL_CACHE_MAX_AGE_MS) delete cache[key];
    }
    await fs.mkdir(getDataDirectory(), { recursive: true });
    await fs.writeFile(getModelCachePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (error: any) {
    // A cache write must never break the model picker.
    logger.warn('Could not write the model cache', { error: error?.message });
  }
}

export async function clearModelCache(): Promise<void> {
  try {
    await fs.rm(getModelCachePath(), { force: true });
  } catch (error: any) {
    logger.warn('Could not clear the model cache', { error: error?.message });
  }
}

/** Test hook: resolve the cache path under a temporary data directory. */
export function setModelCacheDirectoryForTests(dir: string | null): void {
  if (dir === null) {
    delete process.env.XDG_DATA_HOME;
    return;
  }
  process.env.XDG_DATA_HOME = dir;
}

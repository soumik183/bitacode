import type { OpenAI } from 'openai';
import { getModelDetails } from '../providers/index.js';

export interface FetchedModel {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
}

export interface ProviderModelList {
  items: FetchedModel[];
  error: string | null;
  authError: boolean;
}

// Providers expose chat and non-chat models on the same OpenAI-compatible
// /models endpoint. Hide the obvious non-chat families; if that removes
// everything, keep the raw list rather than showing an empty picker.
const NON_CHAT_MODEL =
  /(embedding|whisper|tts|dall-e|moderation|transcribe|speech|image|audio|sora|^gpt-3\.5-turbo-instruct$|babbage|davinci)/i;

const MAX_MODELS = 300;

export function formatContextWindow(contextWindow?: number): string | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined;
  if (contextWindow >= 1_000_000) {
    return `${Number((contextWindow / 1_000_000).toFixed(1))}M ctx`;
  }
  return `${Math.round(contextWindow / 1000)}k ctx`;
}

/** Fetch a provider's live model list through its OpenAI-compatible API. */
export async function listProviderModels(
  client: OpenAI,
  providerId: string
): Promise<ProviderModelList> {
  try {
    const page = await client.models.list({ timeout: 10_000, maxRetries: 0 });
    const data = (page as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { items: [], error: 'The provider returned no model list.', authError: false };
    }

    const seen = new Set<string>();
    const all: FetchedModel[] = [];
    for (const raw of data as Array<Record<string, any>>) {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const details = getModelDetails(providerId, id);
      const rawContext = Number(raw.context_length ?? raw.context_window ?? 0);
      const contextWindow = rawContext > 0 ? rawContext : details?.contextWindow;
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : details?.name;

      all.push({
        id,
        label: name ?? id,
        description: formatContextWindow(contextWindow),
        contextWindow,
      });
    }

    const chat = all.filter((model) => !NON_CHAT_MODEL.test(model.id));
    const items = (chat.length > 0 ? chat : all)
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, MAX_MODELS);

    return { items, error: null, authError: false };
  } catch (err: any) {
    const status = Number(err?.status ?? err?.response?.status ?? 0);
    const message = String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 200);
    // Some providers report a bad key as 400 (Google) instead of 401.
    const keyRejected =
      status === 401 ||
      status === 403 ||
      (status >= 400 && status < 500 && /(api.?key|unauthorized|authentication|permission)/i.test(message));
    return { items: [], error: message, authError: keyRejected };
  }
}

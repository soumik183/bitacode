/**
 * web_search tool — query DuckDuckGo's HTML endpoint (no API key required).
 * Built-in fetch only; results are parsed from HTML with a small regex.
 * Multiple queries run in parallel and are emitted in a structured line format.
 */

import {
  formatWebSearchResult,
  type WebSearchBlock,
  type WebSearchResource,
} from '../utils/web-search-result.js';

export const webSearchTool = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web with DuckDuckGo and return the top results (URL and snippet). ' +
      'Supports parallel multi-query search: pass 2-5 queries in `queries` to search them all at once. ' +
      'No API key required. Blocked or timed-out requests return a clear error.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (1-500 characters).' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: '2-5 search queries to run in parallel.',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default 15, range 5-30).' },
      },
      anyOf: [{ required: ['query'] }, { required: ['queries'] }],
    },
  },
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  timeout?: number;
  signal?: AbortSignal;
}

interface QueryResult {
  resources: WebSearchResource[];
  error?: string;
  related: string[];
}

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 8;
const MAX_QUERIES = 5;
const DEFAULT_TIMEOUT = 15;
const RETRY_DELAY_MS = 250;

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; BitacodeWebSearch/1.0)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Small HTML entity decoder so no dependency is needed. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

/** Normalise a value to a single line, replacing pipes so fields stay parseable. */
function oneLine(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '/');
}

/** Parse DuckDuckGo HTML result anchors into title/url/snippet records. */
export function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a\b[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    const anchor = match[0];
    const hrefMatch = anchor.match(/href="([^"]*)"/i);
    const titleMatch = anchor.match(/>([\s\S]*?)<\/a>/i);
    if (!hrefMatch || !titleMatch) continue;

    let url = decodeEntities(hrefMatch[1]);
    // DuckDuckGo wraps destination URLs as /l/?uddg=<encoded-url>.
    if (url.includes('uddg=')) {
      try {
        const parsed = new URL(url, 'https://duckduckgo.com');
        url = parsed.searchParams.get('uddg') || url;
      } catch {
        // Keep the original href if it cannot be parsed.
      }
    }
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue; // SSRF-safe: only absolute http(s) URLs.

    const title = decodeEntities(stripTags(titleMatch[1])).trim();
    const segment = html.slice(match.index + anchor.length, match.index + anchor.length + 2000);
    const snippetMatch = segment.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    const snippet = snippetMatch
      ? decodeEntities(stripTags(snippetMatch[1])).trim()
      : '';

    results.push({ title: title || '(untitled)', url, snippet });
  }
  return results;
}

/** Extract DuckDuckGo related-search phrases (cap 4) from an HTML page. */
export function parseDdgRelated(html: string): string[] {
  const found: string[] = [];
  const push = (raw: string): void => {
    const value = oneLine(decodeEntities(raw));
    if (value && !found.includes(value) && found.length < 4) found.push(value);
  };

  // Explicit DuckDuckGo related-search items.
  const itemRe = /<[^>]*class="[^"]*related-search-item[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) !== null) {
    const attr = match[0].match(/\bdata-(?:query|value)="([^"]*)"/i);
    push(attr ? attr[1] : stripTags(match[0].replace(/^<[^>]+>/, '')));
  }

  // Any query-bearing element inside a related-searches container.
  const containerRe = /class="[^"]*related-searches[^"]*"[\s\S]*?(?:<\/div>|$)/gi;
  while ((match = containerRe.exec(html)) !== null) {
    const attrRe = /\bdata-(?:query|value)="([^"]*)"/gi;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(match[0])) !== null) push(attr[1]);
  }

  // Generic fallback for pages that only expose a data-query attribute.
  if (found.length === 0) {
    const attrRe = /\bdata-query="([^"]*)"/gi;
    while ((match = attrRe.exec(html)) !== null) push(match[1]);
  }

  return found;
}

/** Deterministic fallbacks when the page has no related-search phrases. */
function deriveRelated(query: string): string[] {
  if (query.trim().split(/\s+/).filter(Boolean).length < 2) return [];
  return [`${query} examples`, `${query} best practices`].map(oneLine);
}

function normalizeQueries(input: string | string[]): string[] {
  const raw: unknown[] = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const query = item.trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= MAX_QUERIES) break;
  }
  return queries;
}

function isAbort(err: unknown): boolean {
  return (err as any)?.name === 'AbortError';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timedOut(timeoutSeconds: number): QueryResult {
  return { resources: [], error: `Error: web search timed out after ${timeoutSeconds}s.`, related: [] };
}

function blocked(): QueryResult {
  return {
    resources: [],
    error: 'Error: web search is blocked by the provider (captcha/anomaly page returned).',
    related: [],
  };
}

async function runQuery(
  query: string,
  timeoutSeconds: number,
  externalSignal?: AbortSignal,
): Promise<QueryResult> {
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      resources: [],
      error: `Error: query too long (${query.length} characters, max ${MAX_QUERY_LENGTH}).`,
      related: [],
    };
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = () => {
    timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  };
  armTimer();

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const doFetch = () => fetch(url, { signal: controller.signal, headers: FETCH_HEADERS });

  try {
    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      if (isAbort(err) || externalSignal?.aborted) return timedOut(timeoutSeconds);
      // One bounded retry after a short pause for transient network errors.
      await delay(RETRY_DELAY_MS);
      if (externalSignal?.aborted) return timedOut(timeoutSeconds);
      if (timer) clearTimeout(timer);
      armTimer();
      try {
        response = await doFetch();
      } catch (retryErr) {
        if (isAbort(retryErr) || externalSignal?.aborted) return timedOut(timeoutSeconds);
        return { resources: [], error: `Error: web search failed: ${messageOf(retryErr)}`, related: [] };
      }
    }

    if (!response.ok) {
      return {
        resources: [],
        error: `Error: web search failed (HTTP ${response.status} ${response.statusText}). The provider may be blocking requests.`,
        related: [],
      };
    }

    let html: string;
    try {
      html = await response.text();
    } catch (err) {
      if (isAbort(err) || externalSignal?.aborted) return timedOut(timeoutSeconds);
      return { resources: [], error: `Error: web search failed: ${messageOf(err)}`, related: [] };
    }

    if (/captcha|anomaly|unusual traffic|blocked|robot check/i.test(html.slice(0, 5000))) {
      return blocked();
    }

    const results = parseDdgHtml(html).slice(0, MAX_RESULTS);
    if (results.length === 0) {
      return { resources: [], error: `No results found for "${query}".`, related: [] };
    }

    const resources: WebSearchResource[] = results.map((result) => ({
      url: result.url,
      text: result.snippet,
    }));
    const parsedRelated = parseDdgRelated(html);
    return { resources, related: parsedRelated.length > 0 ? parsedRelated : deriveRelated(query) };
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

export async function webSearch(
  query: string | string[],
  options?: number | WebSearchOptions,
): Promise<string> {
  try {
    const opts: WebSearchOptions = typeof options === 'number' ? { timeout: options } : (options ?? {});
    const queries = normalizeQueries(query);
    if (queries.length === 0) return 'Error: query is required.';

    const requested = Number(opts.timeout ?? DEFAULT_TIMEOUT);
    const timeoutSeconds = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 5), 30)
      : DEFAULT_TIMEOUT;

    const settled = await Promise.allSettled(
      queries.map((q) => runQuery(q, timeoutSeconds, opts.signal)),
    );

    const blocks: WebSearchBlock[] = [];
    const related: string[] = [];
    for (let i = 0; i < queries.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'rejected') {
        blocks.push({
          query: queries[i],
          resources: [],
          error: `Error: web search failed: ${messageOf(outcome.reason)}`,
        });
        continue;
      }
      const result = outcome.value;
      blocks.push({
        query: queries[i],
        resources: result.resources,
        ...(result.error ? { error: result.error } : {}),
      });
      if (!result.error) {
        for (const item of result.related) {
          if (!related.includes(item) && related.length < 6) related.push(item);
        }
      }
    }

    const errors = blocks.flatMap((block) => (block.error ? [block.error] : []));
    return formatWebSearchResult({ queries, blocks, related, errors });
  } catch {
    return 'Error: query is required.';
  }
}

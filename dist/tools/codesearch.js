/** codesearch tool — keyless public code search via grep.app. */
import { decodeEntities } from './web-search.js';
import { NETWORK_TIMEOUT_MS, MAX_QUERY_LENGTH, MAX_RESULTS, timeoutSignal, isBlocked, validQuery, formatSearchResult, } from './search-helpers.js';
export const codesearchTool = {
    type: 'function',
    function: {
        name: 'codesearch',
        description: 'Search public source code across GitHub repositories (no API key required). ' +
            'Returns title — url — snippet lines. Blocked or timed-out requests return a clear error.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Code search query (1-500 characters).' },
                language: { type: 'string', description: 'Optional language filter, e.g. "typescript".' },
                limit: { type: 'number', description: 'Maximum number of results (1-10, default 10).' },
            },
            required: ['query'],
        },
    },
};
/** Parse a grep.app JSON response into code hits (keyless public code search). */
export function parseCodeSearchResponse(data) {
    const root = data && typeof data === 'object' ? data : {};
    const hits = Array.isArray(root?.hits?.hits)
        ? root.hits.hits
        : Array.isArray(root?.results)
            ? root.results
            : Array.isArray(root?.items)
                ? root.items
                : [];
    const out = [];
    for (const hit of hits) {
        if (!hit || typeof hit !== 'object')
            continue;
        const repo = typeof hit.repo === 'string' ? hit.repo : '';
        const filePath = typeof hit.path === 'string' ? hit.path : '';
        const rawSnippet = (hit.content && typeof hit.content === 'object' && typeof hit.content.snippet === 'string'
            ? hit.content.snippet
            : typeof hit.content === 'string'
                ? hit.content
                : typeof hit.snippet === 'string'
                    ? hit.snippet
                    : '');
        const snippet = decodeEntities(rawSnippet.replace(/<\/?mark>/g, '').replace(/<[^>]+>/g, ''))
            .replace(/\s+/g, ' ')
            .trim();
        const title = `${repo}/${filePath}`.replace(/^\/+|\/+$/g, '') || '(untitled)';
        let url = typeof hit.url === 'string' && /^https?:\/\//i.test(hit.url)
            ? hit.url
            : `https://github.com/${repo}/blob/HEAD/${filePath}`;
        if (url.includes('undefined'))
            url = `https://github.com/${repo || 'search'}`;
        out.push({ title, url, snippet });
    }
    return out;
}
function clampLimit(value, fallback = MAX_RESULTS) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_RESULTS) : fallback;
}
export async function codesearch(query, language, limit) {
    if (!validQuery(query))
        return 'Error: query is required.';
    const q = query.trim();
    if (q.length > MAX_QUERY_LENGTH) {
        return `Error: query too long (${q.length} characters, max ${MAX_QUERY_LENGTH}).`;
    }
    const count = clampLimit(limit);
    const url = new URL('https://grep.app/api/search');
    url.searchParams.set('q', q);
    if (typeof language === 'string' && language.trim()) {
        url.searchParams.set('filter[lang][0]', language.trim().toLowerCase());
    }
    let data;
    try {
        const response = await fetch(url, {
            signal: timeoutSignal(),
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BitacodeCodeSearch/1.0)',
                Accept: 'application/json, text/html;q=0.9',
            },
        });
        if (!response.ok) {
            return `Error: code search failed (HTTP ${response.status} ${response.statusText}). The provider may be blocking requests.`;
        }
        const body = await response.text();
        if (isBlocked(body)) {
            return 'Error: code search is blocked by the provider (captcha/access denied page returned).';
        }
        try {
            data = JSON.parse(body);
        }
        catch {
            return 'Error: code search returned an unexpected (non-JSON) response.';
        }
    }
    catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            return `Error: code search timed out after ${NETWORK_TIMEOUT_MS / 1000}s.`;
        }
        return `Error: code search failed: ${err?.message ?? String(err)}`;
    }
    try {
        const hits = parseCodeSearchResponse(data).slice(0, count);
        if (hits.length === 0)
            return `No code results found for "${q}".`;
        return hits.map((hit) => formatSearchResult(hit.title, hit.url, hit.snippet)).join('\n');
    }
    catch (err) {
        return `Error: code search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

/** search_docs tool — documentation search via DuckDuckGo HTML (keyless). */
import { parseDdgHtml } from './web-search.js';
import { MAX_QUERY_LENGTH, MAX_RESULTS, timeoutSignal, isBlocked, validQuery, formatSearchResult, } from './search-helpers.js';
export const searchDocsTool = {
    type: 'function',
    function: {
        name: 'search_docs',
        description: 'Search documentation from an allowlist of sources (MDN, Node.js, TypeScript). ' +
            'Returns title — url — snippet lines. Blocked or timed-out requests return a clear error.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Documentation search query (1-500 characters).' },
                source: {
                    type: 'string',
                    enum: ['mdn', 'node', 'typescript', 'all'],
                    description: 'Which documentation source to search. Defaults to "all".',
                },
            },
            required: ['query'],
        },
    },
};
const DOC_SOURCES = {
    mdn: 'site:developer.mozilla.org',
    node: 'site:nodejs.org',
    typescript: 'site:typescriptlang.org',
};
export async function searchDocs(query, source = 'all') {
    if (!validQuery(query))
        return 'Error: query is required.';
    const q = query.trim();
    if (q.length > MAX_QUERY_LENGTH) {
        return `Error: query too long (${q.length} characters, max ${MAX_QUERY_LENGTH}).`;
    }
    const requested = typeof source === 'string' ? source.toLowerCase() : 'all';
    if (requested !== 'all' && !(requested in DOC_SOURCES)) {
        return `Error: invalid source "${source}". Expected one of: mdn, node, typescript, all.`;
    }
    const sources = requested === 'all' ? Object.keys(DOC_SOURCES) : [requested];
    const lines = [];
    const errors = [];
    try {
        for (const key of sources) {
            if (lines.length >= MAX_RESULTS)
                break;
            const searchQuery = `${DOC_SOURCES[key]} ${q}`;
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
            try {
                const response = await fetch(url, {
                    signal: timeoutSignal(),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; BitacodeDocsSearch/1.0)',
                        Accept: 'text/html,application/xhtml+xml',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                });
                if (!response.ok) {
                    errors.push(`${key}: HTTP ${response.status}`);
                    continue;
                }
                const html = await response.text();
                if (isBlocked(html)) {
                    errors.push(`${key}: blocked by provider`);
                    continue;
                }
                for (const result of parseDdgHtml(html)) {
                    if (lines.length >= MAX_RESULTS)
                        break;
                    lines.push(formatSearchResult(result.title, result.url, result.snippet));
                }
            }
            catch (err) {
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                    errors.push(`${key}: timed out`);
                }
                else {
                    errors.push(`${key}: ${err?.message ?? String(err)}`);
                }
            }
        }
        if (lines.length === 0) {
            if (errors.length > 0) {
                return `Error: documentation search unavailable (${errors.join('; ')}).`;
            }
            return `No documentation results found for "${q}".`;
        }
        return lines.join('\n');
    }
    catch (err) {
        return `Error: documentation search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

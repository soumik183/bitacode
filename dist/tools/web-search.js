/**
 * web_search tool — query DuckDuckGo's HTML endpoint (no API key required).
 * Built-in fetch only; results are parsed from HTML with a small regex.
 */
export const webSearchTool = {
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the web with DuckDuckGo and return the top results (title, URL, snippet). ' +
            'No API key required. Blocked or timed-out requests return a clear error.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query (1-500 characters).' },
                timeout: { type: 'number', description: 'Timeout in seconds (default 15, range 5-30).' },
            },
            required: ['query'],
        },
    },
};
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 8;
/** Small HTML entity decoder so no dependency is needed. */
export function decodeEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
function stripTags(text) {
    return text.replace(/<[^>]+>/g, '');
}
/** Parse DuckDuckGo HTML result anchors into title/url/snippet records. */
export function parseDdgHtml(html) {
    const results = [];
    const anchorRe = /<a\b[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const anchor = match[0];
        const hrefMatch = anchor.match(/href="([^"]*)"/i);
        const titleMatch = anchor.match(/>([\s\S]*?)<\/a>/i);
        if (!hrefMatch || !titleMatch)
            continue;
        let url = decodeEntities(hrefMatch[1]);
        // DuckDuckGo wraps destination URLs as /l/?uddg=<encoded-url>.
        if (url.includes('uddg=')) {
            try {
                const parsed = new URL(url, 'https://duckduckgo.com');
                url = parsed.searchParams.get('uddg') || url;
            }
            catch {
                // Keep the original href if it cannot be parsed.
            }
        }
        if (url.startsWith('//'))
            url = `https:${url}`;
        if (!/^https?:\/\//i.test(url))
            continue;
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
export async function webSearch(query, timeout) {
    if (typeof query !== 'string' || query.trim().length === 0) {
        return 'Error: query is required.';
    }
    const q = query.trim();
    if (q.length > MAX_QUERY_LENGTH) {
        return `Error: query too long (${q.length} characters, max ${MAX_QUERY_LENGTH}).`;
    }
    const requested = Number(timeout ?? 15);
    const timeoutSeconds = Number.isFinite(requested)
        ? Math.min(Math.max(requested, 5), 30)
        : 15;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    let html;
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BitacodeWebSearch/1.0)',
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });
        if (!response.ok) {
            return `Error: web search failed (HTTP ${response.status} ${response.statusText}). The provider may be blocking requests.`;
        }
        html = await response.text();
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            return `Error: web search timed out after ${timeoutSeconds}s.`;
        }
        return `Error: web search failed: ${err?.message ?? String(err)}`;
    }
    finally {
        clearTimeout(timer);
    }
    if (/captcha|anomaly|unusual traffic|blocked|robot check/i.test(html.slice(0, 5000))) {
        return 'Error: web search is blocked by the provider (captcha/anomaly page returned).';
    }
    const results = parseDdgHtml(html).slice(0, MAX_RESULTS);
    if (results.length === 0) {
        return `No results found for "${q}".`;
    }
    return results
        .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
        .join('\n');
}

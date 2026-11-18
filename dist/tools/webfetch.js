/**
 * webfetch tool — Fetch and process web content
 *
 * Features:
 * - Single URL fetch per invocation
 * - Three output formats: text, markdown, html
 * - Configurable timeout (default 30s, max 120s)
 * - 5MB response size limit + 2MB output limit
 * - HTML to text/markdown conversion
 * - AbortController support for cancellation
 * - Robust HTML entity decoding
 * - Proper redirect limiting
 * - Charset-aware content decoding
 */
import { convert } from "html-to-text";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_OUTPUT_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_REDIRECTS = 10;
const MAX_URL_LENGTH = 4096;
const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
};
// Text-based MIME types that are safe to process
const TEXT_MIME_TYPES = [
    "text/",
    "application/json",
    "application/xml",
    "application/x-www-form-urlencoded",
    "application/atom+xml",
    "application/rss+xml",
    "application/javascript",
    "application/typescript",
];
// ─── SSRF protection (pure helpers are exported for offline tests) ───
/** Strip IPv6 brackets from a URL hostname. */
function stripBrackets(host) {
    return host.replace(/^\[|\]$/g, "");
}
/**
 * True for IPs that must never be fetched: loopback, link-local (including the
 * 169.254.169.254 cloud metadata endpoint), private ranges, and IPv6
 * loopback / link-local / unique-local / multicast / unspecified addresses.
 */
export function isUnsafeAddress(address) {
    const ip = stripBrackets(address).toLowerCase();
    const version = isIP(ip);
    if (version === 4) {
        const [a, b] = ip.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127)
            return true; // this-net, private, loopback
        if (a === 169 && b === 254)
            return true; // link-local / cloud metadata
        if (a === 172 && b >= 16 && b <= 31)
            return true; // private
        if (a === 192 && b === 168)
            return true; // private
        if (a === 100 && b >= 64 && b <= 127)
            return true; // CGNAT
        if (a >= 224)
            return true; // multicast / reserved
        return false;
    }
    if (version === 6) {
        if (ip === "::" || ip === "::1")
            return true; // unspecified / loopback
        if (/^fe[89ab][0-9a-f]/.test(ip))
            return true; // fe80::/10 link-local
        if (/^f[cd][0-9a-f]{2}/.test(ip))
            return true; // fc00::/7 unique local
        if (/^ff/.test(ip))
            return true; // ff00::/8 multicast
        const mapped = ip.match(/^::ffff:(.+)$/);
        if (mapped) {
            const rest = mapped[1];
            if (rest.includes("."))
                return isUnsafeAddress(rest);
            const parts = rest.split(":");
            if (parts.length === 2) {
                const hi = parseInt(parts[0], 16);
                const lo = parseInt(parts[1], 16);
                return isUnsafeAddress([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."));
            }
        }
        return false;
    }
    return false; // not a literal IP — resolved via DNS below
}
/** Reject a URL whose hostname is (or resolves to) a private/loopback address. */
async function assertPublicUrl(url) {
    const parsed = new URL(url);
    const host = stripBrackets(parsed.hostname);
    if (isUnsafeAddress(host)) {
        throw new Error(`Refusing to fetch '${url}': host '${host}' is a private, loopback, or link-local address.`);
    }
    try {
        const addresses = await lookup(host, { all: true, verbatim: true });
        if (addresses.length === 0)
            throw new Error("no addresses found");
        for (const { address } of addresses) {
            if (isUnsafeAddress(address)) {
                throw new Error(`resolves to private/loopback/link-local address ${address}`);
            }
        }
    }
    catch (err) {
        const msg = err.message;
        throw new Error(`Refusing to fetch '${url}': host '${host}' ${msg === "no addresses found" || msg.startsWith("resolves to") ? msg : `could not be resolved (${msg})`}.`);
    }
}
// ─── Noise removal (exported for offline tests) ───
const NOISE_TAGS = ["nav", "header", "footer", "aside", "form", "script", "style", "noscript", "svg"];
/** Remove navigation/chrome/script blocks so the model isn't fed page furniture. */
export function stripNoiseTags(html) {
    let out = html;
    for (const tag of NOISE_TAGS) {
        out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
        out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, "gi"), " ");
    }
    return out;
}
/** Minimal CSS-like filter: tag, #id, or .class. Returns input if nothing matched. */
export function filterBySelector(html, selector) {
    if (!selector)
        return html;
    const s = selector.trim();
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re;
    if (s.startsWith("#")) {
        re = new RegExp(`<\\w+\\b[^>]*\\bid=["']${esc(s.slice(1))}["'][^>]*>[\\s\\S]*?<\\/\\w+\\s*>`, "gi");
    }
    else if (s.startsWith(".")) {
        re = new RegExp(`<\\w+\\b[^>]*\\bclass=["'][^"']*\\b${esc(s.slice(1))}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\w+\\s*>`, "gi");
    }
    else {
        re = new RegExp(`<${esc(s)}\\b[^>]*>[\\s\\S]*?<\\/${esc(s)}\\s*>`, "gi");
    }
    const found = html.match(re);
    return found ? found.join("\n") : html;
}
// Lazy-loaded Turndown instance — converts HTML to Markdown
// We lazy-load because Turndown is a CommonJS module; dynamic import keeps our
// ESM output clean without forcing esbuild to bundle everything as CJS.
// Why Turndown? HTML → Markdown preserves document structure (headings, lists,
// links) in a readable format that LLMs handle better than raw HTML markup.
let _turndownService = null;
async function getTurndownService() {
    if (!_turndownService) {
        const { default: TurndownService } = await import("turndown");
        _turndownService = new TurndownService({
            headingStyle: "atx", // # Heading, not underlined
            codeBlockStyle: "fenced", // ```code```, not indented
            bulletListMarker: "-",
            emDelimiter: "*",
        });
        // Remove noise that doesn't help LLM understanding
        _turndownService.remove([
            "script", "style", "meta", "link",
            "nav", "header", "footer", "aside", "form", "noscript", "svg",
        ]);
    }
    return _turndownService;
}
// Lazy-loaded 'he' module — decodes HTML entities like &lt; &gt; &amp;
// We lazy-load for the same CJS/ESM reason as Turndown.
// Why 'he'? Browsers and node don't have built-in HTML entity decoding that
// handles the full set (&nbsp;, &#x2713;, named entities, etc.) correctly.
let _he = null;
async function getHe() {
    if (!_he) {
        const { default: he } = await import("he");
        _he = he;
    }
    return _he;
}
/**
 * Check if MIME type is text-based
 */
function isTextMimeType(mimeType) {
    return TEXT_MIME_TYPES.some((type) => mimeType.includes(type));
}
/**
 * Detect if content is HTML
 */
function detectHTML(content, contentType) {
    // Header says HTML
    if (contentType.includes("text/html")) {
        return true;
    }
    // Sniff content for HTML signature
    const trimmed = content.slice(0, 1024).trim().toLowerCase();
    return /^<!doctype html|^<html|^<head|^<body|^<meta/.test(trimmed);
}
/**
 * Parse charset from Content-Type header
 */
function parseCharset(contentType) {
    const match = contentType.match(/charset=([^\s;]+)/i);
    if (match) {
        const charset = match[1].replace(/['"]/g, "");
        // Validate charset is supported by TextDecoder
        try {
            new TextDecoder(charset);
            return charset;
        }
        catch {
            return "utf-8";
        }
    }
    return "utf-8";
}
/**
 * Truncate output if too large
 */
function truncateOutput(output, maxSize) {
    if (output.length > maxSize) {
        const truncatedSize = Math.max(100, maxSize - 100);
        return (output.slice(0, truncatedSize) +
            `\n\n[Content truncated: ${output.length} characters exceeds ${maxSize} limit]`);
    }
    return output;
}
/**
 * Read a response body while enforcing the size limit incrementally.
 * Buffering first and checking afterwards could exhaust memory on a huge
 * response that omits Content-Length.
 */
async function readBodyWithLimit(response, maxBytes) {
    if (!response.body)
        return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`Response too large (exceeds ${maxBytes / 1024 / 1024}MB limit)`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
/** Release the connection instead of leaving an unread body behind. */
async function discardBody(response) {
    await response.body?.cancel().catch(() => undefined);
}
export const webfetchTool = {
    type: "function",
    function: {
        name: "webfetch",
        description: "Fetch and process content from a web URL. Supports text (plain text extraction), markdown (HTML to markdown conversion), or html (raw HTML) output formats.",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "HTTP(S) URL to fetch (must start with http:// or https://)",
                },
                format: {
                    type: "string",
                    enum: ["text", "markdown", "html"],
                    description: "Output format: text (plain text), markdown (HTML to markdown), or html (raw HTML)",
                },
                timeout: {
                    type: "number",
                    description: "Timeout in seconds (default 30, min 1, max 120)",
                },
                selector: {
                    type: "string",
                    description: "Optional simple CSS-like filter (tag, #id, or .class) to limit extracted content.",
                },
            },
            required: ["url", "format"],
        },
    },
};
/**
 * Convert HTML to plain text using html-to-text library
 */
function htmlToText(html) {
    try {
        return convert(html, {
            wordwrap: 120,
            selectors: [
                { selector: "img", options: { ignoreHref: true } },
                { selector: "a", options: { ignoreHref: true } },
            ],
        });
    }
    catch {
        // Fallback: basic regex if library fails
        return html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join("\n");
    }
}
/**
 * Convert HTML to Markdown using Turndown (cached instance)
 */
async function htmlToMarkdown(html) {
    try {
        const turndown = await getTurndownService();
        return turndown.turndown(html);
    }
    catch {
        // Fallback: treat as code block
        return `\`\`\`html\n${html}\n\`\`\``;
    }
}
/**
 * Fetch with redirect limiting
 */
async function fetchWithRedirectLimit(url, signal) {
    let redirectCount = 0;
    let currentUrl = url;
    // Create a custom fetch wrapper that tracks redirects
    const originalFetch = global.fetch;
    while (redirectCount < MAX_REDIRECTS) {
        const response = await originalFetch(currentUrl, {
            signal,
            headers: FETCH_HEADERS,
            redirect: "manual", // Handle redirects manually to count them
        });
        // Check for redirect status
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (location) {
                redirectCount++;
                // Resolve relative URLs, but never follow a redirect into a private
                // network (DNS rebinding / internal-service pivot).
                currentUrl = new URL(location, currentUrl).href;
                await assertPublicUrl(currentUrl);
                await discardBody(response);
                continue;
            }
        }
        return response;
    }
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}
/**
 * Fetch and process a URL
 *
 * @param url - HTTP(S) URL to fetch
 * @param format - Output format: 'text', 'markdown', or 'html'
 * @param timeout - Optional timeout in seconds (default 30, max 120)
 * @param selector - Optional simple CSS-like filter (tag, #id, or .class)
 * @returns Object with output, title, and metadata
 * @throws Error on validation, network, or processing failures
 */
export async function webfetch(url, format, timeout, selector) {
    if (typeof url !== "string" || url.length === 0) {
        throw new Error("A URL is required.");
    }
    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch {
        throw new Error("Invalid URL. Must be an absolute http:// or https:// URL.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Invalid URL protocol. Must be http:// or https://.");
    }
    if (url.length > MAX_URL_LENGTH) {
        throw new Error(`URL too long (${url.length} characters, max ${MAX_URL_LENGTH})`);
    }
    // SSRF guard: reject private/loopback/link-local targets before any network call
    await assertPublicUrl(url);
    // Validate format
    if (!["text", "markdown", "html"].includes(format)) {
        throw new Error("Invalid format. Must be 'text', 'markdown', or 'html'");
    }
    // Validate timeout (default 30s, clamp to 1–120s)
    const requestedTimeout = Number(timeout ?? 30);
    const timeoutSeconds = Number.isFinite(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 1), 120)
        : 30;
    // Setup timeout for entire operation
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        const startTime = Date.now();
        // Fetch with redirect limiting
        const response = await fetchWithRedirectLimit(url, controller.signal);
        // Check HTTP status
        if (!response.ok) {
            await discardBody(response);
            throw new Error(`HTTP ${response.status} error: ${response.statusText}`);
        }
        // Validate response size by header
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            await discardBody(response);
            throw new Error(`Response too large (exceeds 5MB limit). Content-Length: ${contentLength}`);
        }
        // Get content type
        const contentType = response.headers.get("content-type") ?? "text/plain";
        // Check if content type is text-based
        if (!isTextMimeType(contentType)) {
            await discardBody(response);
            throw new Error(`Content type '${contentType}' is not supported. Only text-based formats are allowed.`);
        }
        // Read raw bytes (not .text()) because response.text() always decodes as
        // UTF-8 and would corrupt non-UTF-8 pages. The size limit is enforced
        // while streaming so an oversized body cannot exhaust memory.
        const bytes = await readBodyWithLimit(response, MAX_RESPONSE_SIZE);
        // Parse charset from Content-Type header
        const charset = parseCharset(contentType);
        // Decode response with appropriate charset
        const decoder = new TextDecoder(charset, { fatal: false });
        const content = decoder.decode(bytes);
        const isHTML = detectHTML(content, contentType);
        // Narrow to the requested region (if any), then drop navigation chrome
        // before text/markdown conversion so the model isn't fed page furniture.
        const cleaned = isHTML ? stripNoiseTags(filterBySelector(content, selector)) : content;
        // Format content based on requested format
        let output;
        if (format === "text") {
            output = isHTML ? htmlToText(cleaned) : content;
        }
        else if (format === "markdown") {
            output = isHTML
                ? await htmlToMarkdown(cleaned)
                : `\`\`\`\n${content}\n\`\`\``;
        }
        else {
            // format === 'html'
            output = content;
        }
        // Decode HTML entities ONLY for text/markdown formats (not for raw HTML)
        if (format !== "html") {
            const he = await getHe();
            output = he.decode(output);
        }
        // Truncate output if too large
        output = truncateOutput(output, MAX_OUTPUT_SIZE);
        const fetchTime = Date.now() - startTime;
        const title = `${url} (${contentType})`;
        const metadata = {
            url,
            format,
            contentType,
            charset,
            contentLength: bytes.byteLength,
            outputLength: output.length,
            fetchTime,
        };
        return { output, title, metadata };
    }
    catch (error) {
        // Handle AbortError (timeout or cancellation)
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Fetch timeout after ${timeoutSeconds} seconds`);
        }
        // Re-throw our errors as-is
        if (error instanceof Error) {
            throw error;
        }
        // Handle unexpected errors
        throw new Error(`Failed to fetch ${url}: ${String(error)}`);
    }
    finally {
        clearTimeout(timeoutId);
    }
}

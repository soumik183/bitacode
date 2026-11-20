/**
 * Line-oriented result format shared by the web_search tool and its renderer.
 *
 * Keeping the formatter and parser here makes the wire format a single source
 * of truth and lets the tool be tested without depending on the UI.
 */

export interface WebSearchResource {
  url: string;
  text: string;
}

export interface WebSearchBlock {
  query: string;
  resources: WebSearchResource[];
  error?: string;
}

export interface WebSearchPayload {
  queries: string[];
  blocks: WebSearchBlock[];
  related: string[];
  errors: string[];
}

/** Collapse whitespace and strip newlines so every value stays on one line. */
function oneLine(value: string): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Serialise a payload into the WEB_SEARCH line format. */
export function formatWebSearchResult(payload: WebSearchPayload): string {
  const lines: string[] = ['WEB_SEARCH'];
  for (const block of payload.blocks) {
    lines.push(`QUERY: ${oneLine(block.query)}`);
    for (const resource of block.resources) {
      lines.push(`RESOURCE: ${oneLine(resource.url)}`);
      lines.push(`TEXT: ${oneLine(resource.text)}`);
    }
    if (block.error) lines.push(`ERROR: ${oneLine(block.error)}`);
  }
  if (payload.related.length > 0) {
    const related = payload.related
      .map((item) => oneLine(item).replace(/\|/g, '/'))
      .filter(Boolean);
    if (related.length > 0) lines.push(`RELATED: ${related.join(' | ')}`);
  }
  return lines.join('\n');
}

/** Returns null when the raw string is not a web_search result. */
export function parseWebSearchResult(raw: string): WebSearchPayload | null {
  if (typeof raw !== 'string') return null;
  try {
    if (!raw.trim().startsWith('WEB_SEARCH')) return null;

    const queries: string[] = [];
    const blocks: WebSearchBlock[] = [];
    const errors: string[] = [];
    const related: string[] = [];
    let current: WebSearchBlock | null = null;

    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (value.startsWith('QUERY:')) {
        const query = oneLine(value.slice('QUERY:'.length));
        current = { query, resources: [] };
        blocks.push(current);
        queries.push(query);
      } else if (value.startsWith('RESOURCE:')) {
        if (!current) continue;
        current.resources.push({ url: oneLine(value.slice('RESOURCE:'.length)), text: '' });
      } else if (value.startsWith('TEXT:')) {
        if (!current || current.resources.length === 0) continue;
        current.resources[current.resources.length - 1].text = oneLine(value.slice('TEXT:'.length));
      } else if (value.startsWith('ERROR:')) {
        const error = oneLine(value.slice('ERROR:'.length));
        errors.push(error);
        if (current && !current.error) current.error = error;
      } else if (value.startsWith('RELATED:')) {
        for (const part of value.slice('RELATED:'.length).split(' | ')) {
          const item = oneLine(part);
          if (item && !related.includes(item)) related.push(item);
        }
      }
      // Unknown lines are intentionally ignored.
    }

    if (blocks.length === 0) return null;
    return { queries, blocks, related, errors };
  } catch {
    return null;
  }
}

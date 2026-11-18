/** search_history tool — read-only search over persisted session JSON files. */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MAX_QUERY_LENGTH, validQuery } from './search-helpers.js';

export const searchHistoryTool = {
  type: 'function' as const,
  function: {
    name: 'search_history',
    description:
      'Search previous session history (titles and message content) for a query string. ' +
      'Read-only. Returns id — title — updatedAt — matched snippet lines.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to find in past sessions.' },
      },
      required: ['query'],
    },
  },
};

const MAX_HISTORY_RESULTS = 30;
const MAX_HISTORY_CHARS = 20_000;
const SNIPPET_RADIUS = 80;

interface HistoryMatch {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

function sessionsDir(homeDir: string): string {
  if (process.platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Local', 'bitacode', 'sessions');
  }
  return path.join(homeDir, '.local', 'share', 'bitacode', 'sessions');
}

/** Flatten a chat message's content into searchable text. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

function makeSnippet(text: string, lowerText: string, lowerQuery: string): string {
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + lowerQuery.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Read-only search over persisted session JSON files. Corrupt files are
 * skipped and any unexpected error is returned as an `Error: ...` string.
 */
export async function searchHistory(query: string, homeDir = os.homedir()): Promise<string> {
  if (!validQuery(query)) return 'Error: query is required.';
  const q = query.trim();
  if (q.length > MAX_QUERY_LENGTH) {
    return `Error: query too long (${q.length} characters, max ${MAX_QUERY_LENGTH}).`;
  }
  const lowerQuery = q.toLowerCase();

  try {
    const dir = sessionsDir(homeDir);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return `No matching sessions found for "${q}".`;
      throw err;
    }

    const matches: HistoryMatch[] = [];
    for (const file of files) {
      if (matches.length >= MAX_HISTORY_RESULTS) break;
      let session: any;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        session = JSON.parse(raw);
      } catch {
        continue; // Corrupt or unreadable session file — skip.
      }
      if (!session || typeof session !== 'object') continue;

      const id = typeof session.id === 'string' ? session.id : file.replace(/\.json$/i, '');
      const title = typeof session.title === 'string' ? session.title : '';
      const updatedAt = typeof session.updatedAt === 'string' ? session.updatedAt : '';
      const titleLower = title.toLowerCase();

      if (titleLower.includes(lowerQuery)) {
        matches.push({ id, title, updatedAt, snippet: makeSnippet(title, titleLower, lowerQuery) });
        continue;
      }

      const messages = Array.isArray(session.completionMessages) ? session.completionMessages : [];
      for (const message of messages) {
        const text = messageText(message && typeof message === 'object' ? message.content : undefined);
        if (!text) continue;
        const lower = text.toLowerCase();
        if (lower.includes(lowerQuery)) {
          matches.push({ id, title, updatedAt, snippet: makeSnippet(text, lower, lowerQuery) });
          break; // One snippet per session.
        }
      }
    }

    if (matches.length === 0) return `No matching sessions found for "${q}".`;

    matches.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

    const lines: string[] = [];
    let used = 0;
    for (const match of matches.slice(0, MAX_HISTORY_RESULTS)) {
      const line = `${match.id} — ${match.title} — ${match.updatedAt} — ${match.snippet}`;
      if (used + line.length > MAX_HISTORY_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return `Results exceeded ${MAX_HISTORY_CHARS} characters; try a narrower query.`;
    return lines.join('\n');
  } catch (err) {
    return `Error: history search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

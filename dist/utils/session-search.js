/**
 * session-search.ts — tolerant, read-only full-text search over saved sessions.
 *
 * Sessions are JSON files at
 * `${XDG_DATA_HOME || ~/.local/share}/bitacode/sessions/<id>.json`. This module
 * never creates directories or writes files: one corrupt, unreadable, or
 * hostile entry only costs that entry, logged through `logger.debug`. Only
 * filenames whose stem is a known-safe session id are read, so a search can
 * never be tricked into opening an arbitrary path.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';
/** Short ids (8 alphanumerics) and classic UUIDs are the only readable stems. */
const SHORT_ID_PATTERN = /^[0-9a-z]{8}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_FILES = 500;
const SNIPPET_RADIUS = 80;
const TOOL_NOISE_LIMIT = 4096;
const TITLE_BOOST = 2;
const FALLBACK_TITLE = 'Untitled session';
function isSafeSessionId(id) {
    return SHORT_ID_PATTERN.test(id) || UUID_PATTERN.test(id);
}
function boundedCount(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : fallback;
}
function defaultSessionsDir() {
    const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'bitacode', 'sessions');
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
/** Collapse every whitespace run (including newlines) into one space. */
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/** Keep control characters out of snippets without losing their existence. */
function escapeControlChars(text) {
    return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, (char) => {
        const code = char.charCodeAt(0);
        return code <= 0xff
            ? `\\x${code.toString(16).padStart(2, '0')}`
            : `\\u${code.toString(16).padStart(4, '0')}`;
    });
}
/**
 * Extract the text carried by one content part. Tool output and streamed JSON
 * deltas are "noisy": anything past 4 KiB is dropped so a giant log cannot
 * drown a search result or become an enormous snippet.
 */
function textFromPart(part, noisy) {
    if (typeof part === 'string') {
        return noisy && part.length > TOOL_NOISE_LIMIT ? '' : part;
    }
    if (!part || typeof part !== 'object' || Array.isArray(part))
        return '';
    const record = part;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const partIsNoisy = noisy || type === 'tool_result' || type === 'input_json_delta';
    let text = '';
    if (typeof record.text === 'string') {
        text = record.text;
    }
    else if (typeof record.input_text === 'string') {
        text = record.input_text;
    }
    else if (typeof record.output_text === 'string') {
        text = record.output_text;
    }
    else if (typeof record.partial_json === 'string') {
        text = record.partial_json;
    }
    else if (typeof record.refusal === 'string') {
        text = record.refusal;
    }
    else if (record.function && typeof record.function === 'object' && !Array.isArray(record.function)) {
        const fn = record.function;
        const name = typeof fn.name === 'string' ? fn.name : '';
        const args = typeof fn.arguments === 'string' ? fn.arguments : '';
        text = [name, args].filter(Boolean).join(' ');
    }
    else if (record.content !== undefined) {
        text = collectContent(record.content, partIsNoisy);
    }
    return partIsNoisy && text.length > TOOL_NOISE_LIMIT ? '' : text;
}
/** Flatten string/part content into one searchable string. */
function collectContent(content, noisy) {
    if (typeof content === 'string') {
        return noisy && content.length > TOOL_NOISE_LIMIT ? '' : content;
    }
    if (!Array.isArray(content))
        return '';
    const chunks = [];
    for (const part of content) {
        const text = textFromPart(part, noisy);
        if (text)
            chunks.push(text);
    }
    return chunks.join(' ');
}
/**
 * Turn one persisted message (or a bare content value) into plain searchable
 * text. Handles string content and multimodal part arrays (`text`,
 * `input_json_delta`, tool calls/results, ...). Never throws on malformed data.
 */
export function collectSearchableText(message) {
    try {
        if (message == null)
            return '';
        if (typeof message === 'string')
            return message;
        if (Array.isArray(message))
            return collectContent(message, false);
        if (typeof message !== 'object')
            return String(message);
        const record = message;
        const noisy = record.role === 'tool' || record.role === 'function' || record.role === 'tool_result';
        const chunks = [];
        const contentText = collectContent(record.content, noisy);
        if (contentText)
            chunks.push(contentText);
        if (Array.isArray(record.tool_calls)) {
            for (const call of record.tool_calls) {
                const text = textFromPart(call, true);
                if (text)
                    chunks.push(text);
            }
        }
        return chunks.join(' ');
    }
    catch (err) {
        // Proxy traps, circular structures, and other hostile shapes must not break
        // the whole search. The bad message is simply not searchable.
        logger.debug(`Could not collect session text: ${err}`);
        return '';
    }
}
/** Number of distinct terms present in a piece of text. */
function countMatches(text, terms) {
    if (!text)
        return 0;
    const lower = text.toLowerCase();
    let count = 0;
    for (const term of terms) {
        if (lower.includes(term))
            count++;
    }
    return count;
}
/** A readable ~160-character window centred on the first matching term. */
function makeSnippet(text, terms) {
    const normalized = escapeControlChars(normalizeWhitespace(text));
    if (!normalized)
        return '';
    const lower = normalized.toLowerCase();
    let first = -1;
    let matchLength = 0;
    for (const term of terms) {
        const index = lower.indexOf(term);
        if (index >= 0 && (first < 0 || index < first)) {
            first = index;
            matchLength = term.length;
        }
    }
    if (first < 0)
        first = 0;
    const start = Math.max(0, first - SNIPPET_RADIUS);
    const end = Math.min(normalized.length, first + SNIPPET_RADIUS + matchLength);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < normalized.length ? '...' : '';
    return `${prefix}${normalized.slice(start, end)}${suffix}`;
}
function timestampOf(iso) {
    const stamp = Date.parse(iso);
    return Number.isFinite(stamp) ? stamp : 0;
}
/** Score a parsed session, or return null when any query term is missing. */
function buildCandidate(data, fileId, terms) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return null;
    const session = data;
    const title = normalizeWhitespace(typeof session.title === 'string' ? session.title : '');
    const updatedAt = typeof session.updatedAt === 'string' ? session.updatedAt : '';
    const messages = Array.isArray(session.completionMessages) ? session.completionMessages : [];
    const covered = new Set();
    const titleLower = title.toLowerCase();
    for (const term of terms) {
        if (titleLower.includes(term))
            covered.add(term);
    }
    const titleMatches = countMatches(title, terms);
    let totalMatches = 0;
    let bestText = '';
    let bestCount = 0;
    let bestRole;
    let bestAt;
    for (const message of messages) {
        const text = collectSearchableText(message);
        if (!text)
            continue;
        const lower = text.toLowerCase();
        let count = 0;
        for (const term of terms) {
            if (lower.includes(term)) {
                covered.add(term);
                count++;
            }
        }
        if (count === 0)
            continue;
        totalMatches += count;
        if (count > bestCount) {
            bestCount = count;
            bestText = text;
            const record = message && typeof message === 'object' && !Array.isArray(message)
                ? message
                : null;
            bestRole = record && typeof record.role === 'string' ? record.role : undefined;
            bestAt =
                firstString(record?.ts, record?.timestamp, record?.createdAt, record?.at) ??
                    (updatedAt || undefined);
        }
    }
    // Every term must appear somewhere in the title or the conversation.
    if (covered.size !== terms.length)
        return null;
    const hit = {
        sessionId: fileId,
        title: title || FALLBACK_TITLE,
        snippet: makeSnippet(bestText || title, terms),
        score: totalMatches + titleMatches * TITLE_BOOST,
    };
    if (bestRole !== undefined)
        hit.role = bestRole;
    if (bestAt !== undefined)
        hit.at = bestAt;
    return { hit, updatedAt };
}
async function performSearch(query, options) {
    if (typeof query !== 'string' || query.trim().length === 0) {
        return { ok: false, error: 'Search query must not be empty.' };
    }
    const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
    if (terms.length === 0) {
        return { ok: false, error: 'Search query must not be empty.' };
    }
    const limit = boundedCount(options?.limit, DEFAULT_LIMIT);
    const maxFiles = boundedCount(options?.maxFiles, DEFAULT_MAX_FILES);
    const dir = typeof options?.sessionsDir === 'string' && options.sessionsDir.trim()
        ? options.sessionsDir.trim()
        : defaultSessionsDir();
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch (err) {
        // A missing (or unreadable) sessions dir is a normal empty result. Never
        // create it: this module is strictly read-only.
        logger.debug(`Cannot read sessions directory ${dir}: ${err}`);
        return { ok: true, value: [] };
    }
    const files = entries
        .filter((entry) => entry.isFile() &&
        entry.name.endsWith('.json') &&
        isSafeSessionId(entry.name.slice(0, -'.json'.length)))
        .map((entry) => entry.name)
        .sort()
        .slice(0, maxFiles);
    const candidates = [];
    for (const name of files) {
        try {
            const raw = await fs.readFile(path.join(dir, name), 'utf8');
            const candidate = buildCandidate(JSON.parse(raw), name.slice(0, -'.json'.length), terms);
            if (candidate)
                candidates.push(candidate);
        }
        catch (err) {
            logger.debug(`Skipping unreadable session file ${name}: ${err}`);
        }
    }
    candidates.sort((a, b) => {
        if (b.hit.score !== a.hit.score)
            return b.hit.score - a.hit.score;
        return timestampOf(b.updatedAt) - timestampOf(a.updatedAt);
    });
    // Fresh objects: callers cannot mutate a cached/shared result.
    const value = candidates.slice(0, limit).map((candidate) => ({ ...candidate.hit }));
    return { ok: true, value };
}
/**
 * Search all saved sessions for the given terms (case-insensitive, all terms
 * required). Returns hits sorted by score, then by most recently updated.
 * Filesystem problems degrade to debug logs and an empty/small result set.
 */
export async function searchSessions(query, options) {
    try {
        return await performSearch(query, options);
    }
    catch (err) {
        logger.debug(`Session search failed: ${err}`);
        return { ok: false, error: `Session search failed: ${String(err)}` };
    }
}

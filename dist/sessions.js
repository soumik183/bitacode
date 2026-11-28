/**
 * Session persistence — Save and load conversation history.
 *
 * Sessions are stored as JSON files in `~/.local/share/bitacode/sessions/`.
 * Each session has a unique ID, a title, and the full message history.
 *
 * The agent can resume a previous session or start a new one.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chmodSync } from 'node:fs';
import { clearTodos } from './tools/todo.js';
import { logger } from './utils/logger.js';
import { isUiOnlyMessageField } from './utils/message-sanitize.js';
import { loadSettings } from './settings.js';
import { appendEvent, writeSnapshot } from './utils/session-events.js';
const SESSION_DIR_MODE = 0o700;
const SESSION_FILE_MODE = 0o600;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID_PATTERN = /^[0-9a-z]{8}$/i;
function hardenPermissions(targetPath, mode) {
    if (process.platform === 'win32')
        return;
    chmodSync(targetPath, mode);
}
/** True when an id is one this build can read and write safely. */
export function isValidSessionId(id) {
    // Accept both legacy UUIDs and new short IDs. The patterns include no path
    // separators or dots, so an accepted id can never escape the sessions dir.
    return SESSION_ID_PATTERN.test(id) || SHORT_ID_PATTERN.test(id);
}
function assertValidSessionId(id) {
    if (!isValidSessionId(id)) {
        throw new Error(`Invalid session ID: ${id}`);
    }
}
/** Generate a short, readable session ID (8 alphanumeric characters). */
function generateSessionId() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}
/** True once the transcript has anything beyond the system prompt. */
export function hasConversationMessages(messages) {
    return messages.some((message) => message.role !== 'system');
}
export function ensureSystemPromptAtTop(messages, systemPrompt) {
    const firstSystemIndex = messages.findIndex((message) => message.role === 'system');
    if (firstSystemIndex === -1) {
        return [{ role: 'system', content: systemPrompt }, ...messages];
    }
    const firstSystemMessage = messages[firstSystemIndex];
    const normalizedSystemMessage = {
        ...firstSystemMessage,
        role: 'system',
        content: systemPrompt,
    };
    return [
        normalizedSystemMessage,
        ...messages.slice(0, firstSystemIndex),
        ...messages.slice(firstSystemIndex + 1),
    ];
}
/** Copy a persisted message without UI-only keys, optionally keeping reasoning. */
function stripSessionUiFields(message, keepReasoning) {
    const clean = {};
    for (const [key, value] of Object.entries(message)) {
        if (key === 'reasoning') {
            if (keepReasoning)
                clean[key] = value;
            continue;
        }
        if (isUiOnlyMessageField(key))
            continue;
        clean[key] = value;
    }
    return clean;
}
/**
 * Repair histories that older builds or interrupted turns may leave invalid:
 * an assistant tool call without a result, an orphaned tool result, an
 * empty assistant message, or UI-only fields. Providers reject all of these,
 * which used to make a resumed session fail every request.
 */
export function sanitizeCompletionMessages(messages) {
    const sanitized = [];
    let index = 0;
    while (index < messages.length) {
        const message = messages[index];
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            index++;
            continue;
        }
        if (message.role === 'assistant') {
            const content = message.content;
            const hasContent = (typeof content === 'string' && content.trim().length > 0) ||
                (Array.isArray(content) && content.length > 0);
            const seenCallIds = new Set();
            const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
                .filter((call) => call &&
                typeof call === 'object' &&
                typeof call.id === 'string' &&
                call.id.length > 0 &&
                call.function &&
                typeof call.function === 'object' &&
                typeof call.function.name === 'string' &&
                call.function.name.length > 0)
                .map((call) => {
                if (seenCallIds.has(call.id))
                    return null;
                seenCallIds.add(call.id);
                return typeof call.function.arguments === 'string'
                    ? call
                    : { ...call, function: { ...call.function, arguments: '{}' } };
            })
                .filter(Boolean);
            // Reasoning is a UI-only field, but it must survive save/load so a
            // resumed session can replay the thought above its answer.
            const reasoning = typeof message.reasoning === 'string'
                ? { reasoning: message.reasoning.slice(0, 20_000) }
                : {};
            if (toolCalls.length === 0) {
                // An empty assistant message is not valid history.
                if (hasContent) {
                    const rest = stripSessionUiFields(message, true);
                    delete rest.tool_calls;
                    sanitized.push({ ...rest, ...reasoning });
                }
                index++;
                continue;
            }
            sanitized.push({
                ...stripSessionUiFields(message, true),
                ...reasoning,
                tool_calls: toolCalls,
            });
            index++;
            const answered = new Set();
            while (index < messages.length && messages[index].role === 'tool') {
                const toolMessage = messages[index];
                const id = toolMessage.tool_call_id;
                if (typeof id === 'string' &&
                    toolCalls.some((call) => call.id === id) &&
                    !answered.has(id)) {
                    answered.add(id);
                    sanitized.push({
                        ...stripSessionUiFields(toolMessage, false),
                        content: typeof toolMessage.content === 'string' ? toolMessage.content : String(toolMessage.content ?? ''),
                    });
                }
                index++;
            }
            // Keep every tool call paired with a result. A missing result happens
            // when a turn is saved mid-execution; the provider would reject it.
            for (const call of toolCalls) {
                if (!answered.has(call.id)) {
                    sanitized.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: 'Tool result was missing from the saved session. Re-run the tool if needed.',
                    });
                }
            }
            continue;
        }
        // A tool result outside an assistant tool_calls group is orphaned.
        if (message.role !== 'tool') {
            sanitized.push(stripSessionUiFields(message, false));
        }
        index++;
    }
    return sanitized;
}
function getSessionsDir() {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Local', 'bitacode', 'sessions');
    }
    return path.join(homeDir, '.local', 'share', 'bitacode', 'sessions');
}
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
const TODO_PRIORITIES = new Set(['high', 'medium', 'low']);
/** Drop malformed persisted todos instead of letting them crash the panel. */
function sanitizeTodos(value) {
    if (!Array.isArray(value))
        return [];
    const todos = [];
    for (const item of value) {
        if (!item || typeof item !== 'object')
            continue;
        const todo = item;
        if (typeof todo.id !== 'string' ||
            typeof todo.content !== 'string' ||
            !TODO_STATUSES.has(todo.status) ||
            !TODO_PRIORITIES.has(todo.priority)) {
            continue;
        }
        todos.push({
            id: todo.id,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
        });
    }
    return todos;
}
const SUB_AGENT_STATUSES = new Set(['start', 'done', 'error']);
const MAX_SUB_AGENT_ACTIVITIES = 50;
/**
 * Drop malformed persisted sub-agent activity instead of crashing a resumed
 * session. Missing/invalid input stays undefined so old sessions are unchanged.
 */
function sanitizeSubAgentActivities(value) {
    if (!Array.isArray(value))
        return undefined;
    const activities = [];
    for (const item of value) {
        if (activities.length >= MAX_SUB_AGENT_ACTIVITIES)
            break;
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const activity = item;
        const endedAtOk = activity.endedAt === undefined ||
            (typeof activity.endedAt === 'number' && Number.isFinite(activity.endedAt));
        const toolCallsOk = activity.toolCalls === undefined ||
            (typeof activity.toolCalls === 'number' &&
                Number.isInteger(activity.toolCalls) &&
                activity.toolCalls >= 0);
        const summaryOk = activity.summary === undefined || typeof activity.summary === 'string';
        if (typeof activity.id !== 'string' ||
            activity.id.length === 0 ||
            typeof activity.task !== 'string' ||
            activity.task.length === 0 ||
            !SUB_AGENT_STATUSES.has(activity.status) ||
            typeof activity.startedAt !== 'number' ||
            !Number.isFinite(activity.startedAt) ||
            !endedAtOk ||
            !toolCallsOk ||
            !summaryOk) {
            continue;
        }
        const sanitized = {
            id: activity.id,
            task: activity.task,
            status: activity.status,
            startedAt: activity.startedAt,
        };
        if (typeof activity.endedAt === 'number')
            sanitized.endedAt = activity.endedAt;
        if (typeof activity.toolCalls === 'number')
            sanitized.toolCalls = activity.toolCalls;
        if (typeof activity.summary === 'string')
            sanitized.summary = activity.summary;
        activities.push(sanitized);
    }
    return activities;
}
async function ensureSessionsDir() {
    const dir = getSessionsDir();
    await fs.mkdir(dir, { recursive: true, mode: SESSION_DIR_MODE });
    hardenPermissions(dir, SESSION_DIR_MODE);
    return dir;
}
function sessionPath(id) {
    assertValidSessionId(id);
    return path.join(getSessionsDir(), `${id}.json`);
}
/** Create a new session. */
export function createSession(model, provider) {
    return {
        id: generateSessionId(),
        title: 'New session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model,
        provider,
        todos: [],
        completionMessages: [],
    };
}
/** Serialize writes per session so two saves cannot race over one temp file. */
const saveQueues = new Map();
function isMissing(err) {
    return Boolean(err) && err.code === 'ENOENT';
}
/**
 * One atomic save: unique temp file -> rename, with a single retry if the temp
 * file vanished (another writer won the race, the temp was cleaned, or the
 * directory was recreated). `writeFile` truncates, so a kill mid-write used to
 * leave an unparseable session behind.
 */
async function writeSessionAtomic(filePath, session) {
    const payload = JSON.stringify(session, null, 2);
    const attempt = async () => {
        const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: SESSION_FILE_MODE });
            await fs.rename(tempPath, filePath);
        }
        catch (err) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw err;
        }
    };
    try {
        try {
            await attempt();
        }
        catch (err) {
            if (!isMissing(err))
                throw err;
            // The destination is allowed to exist (a concurrent writer finished).
            // Otherwise recreate the directory and try once with a fresh temp name.
            const existing = await fs.readFile(filePath, 'utf8').catch(() => null);
            if (existing !== null)
                return;
            await fs.mkdir(path.dirname(filePath), { recursive: true, mode: SESSION_DIR_MODE });
            await attempt();
        }
        try {
            hardenPermissions(filePath, SESSION_FILE_MODE);
        }
        catch (err) {
            // A permission change is hygiene, not the save itself.
            logger.warn(`Could not tighten session permissions: ${err}`);
        }
    }
    catch (err) {
        logger.error(`Failed to save session ${session.id}: ${err}`);
        throw err;
    }
}
/**
 * Save a session to disk. Concurrent saves of the same session are queued, so
 * the autosave timer and an explicit save can never both rename the same file.
 */
export async function saveSession(session) {
    await ensureSessionsDir();
    session.updatedAt = new Date().toISOString();
    const filePath = sessionPath(session.id);
    const previous = saveQueues.get(session.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => writeSessionAtomic(filePath, session));
    saveQueues.set(session.id, current);
    try {
        await current;
    }
    finally {
        if (saveQueues.get(session.id) === current)
            saveQueues.delete(session.id);
    }
    logger.debug(`Session saved: ${session.id}`);
    // Opt-in append-only event log. A failure here is diagnostic only — the
    // authoritative JSON session has already been written successfully.
    if (loadSettings().sessionEventLog) {
        void Promise.all([
            writeSnapshot(session.id, session),
            appendEvent({
                sessionId: session.id,
                type: 'note',
                data: { title: session.title, messages: session.completionMessages.length },
            }),
        ]).catch((error) => logger.warn('Session event log write failed', { error: String(error) }));
    }
}
/**
 * Deterministically strip UI-only fields, system/developer turns, orphaned tool
 * results and the oldest whole turns until the session fits `maxBytes`.
 *
 * The result is still a valid message history: the first system message is kept
 * and tool results stay attached to their assistant tool-call message. Nothing
 * here is random, so the same input always yields the same output.
 */
export function pruneSession(session, options = {}) {
    const maxBytes = options.maxBytes ?? 0;
    const keepTurns = options.keepTurns;
    let messages = Array.isArray(session.completionMessages) ? [...session.completionMessages] : [];
    const systemPrefix = messages.length > 0 && messages[0].role === 'system' ? [messages[0]] : [];
    if (keepTurns !== undefined && keepTurns >= 0) {
        const userIndexes = [];
        messages.forEach((message, index) => {
            if (message.role === 'user')
                userIndexes.push(index);
        });
        if (userIndexes.length > keepTurns) {
            const cutoff = userIndexes[Math.max(0, userIndexes.length - keepTurns)];
            messages = [...systemPrefix, ...messages.slice(cutoff)];
        }
    }
    let pruned = { ...session, completionMessages: messages };
    pruned = { ...pruned, completionMessages: sanitizeCompletionMessages(pruned.completionMessages) };
    if (maxBytes > 0) {
        let bytes = JSON.stringify(pruned.completionMessages).length;
        while (bytes > maxBytes && pruned.completionMessages.length > 0) {
            const next = stripOldestTurn(pruned.completionMessages);
            if (next.length === pruned.completionMessages.length)
                break;
            pruned = { ...pruned, completionMessages: next };
            bytes = JSON.stringify(pruned.completionMessages).length;
        }
    }
    return pruned;
}
/**
 * Remove the oldest user→tool run after the system message. The system message
 * and the most recent turn are always kept, so the model still has instructions
 * and the task it is working on.
 */
function stripOldestTurn(messages) {
    const firstSystem = messages.findIndex((message) => message.role === 'system');
    const start = firstSystem >= 0 ? firstSystem + 1 : 0;
    if (start >= messages.length - 1)
        return messages;
    let end = start;
    while (end < messages.length && messages[end].role !== 'user')
        end++;
    if (end >= messages.length)
        return messages;
    // Include the assistant/tool messages that follow this user turn.
    let stop = end + 1;
    while (stop < messages.length && messages[stop].role !== 'user')
        stop++;
    if (stop >= messages.length)
        return messages;
    return [...messages.slice(0, end), ...messages.slice(stop)];
}
/** Render a human summary of a pruned session for the CLI. */
export function describePrune(before, after) {
    const beforeBytes = JSON.stringify(before.completionMessages).length;
    const afterBytes = JSON.stringify(after.completionMessages).length;
    return `pruned ${before.completionMessages.length} -> ${after.completionMessages.length} messages (${beforeBytes} -> ${afterBytes} bytes)`;
}
/** Load a session by ID. Returns null if not found. */
export async function loadSession(id) {
    try {
        const content = await fs.readFile(sessionPath(id), 'utf8');
        const session = JSON.parse(content);
        return {
            id: typeof session.id === 'string' ? session.id : id,
            title: typeof session.title === 'string' ? session.title : 'New session',
            createdAt: typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
            updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
            model: typeof session.model === 'string' ? session.model : '',
            provider: typeof session.provider === 'string' ? session.provider : '',
            variant: typeof session.variant === 'string' ? session.variant : undefined,
            todos: sanitizeTodos(session.todos),
            completionMessages: sanitizeCompletionMessages(Array.isArray(session.completionMessages) ? session.completionMessages : []),
            subAgentActivities: sanitizeSubAgentActivities(session.subAgentActivities),
            // Older files have no pin field; only real booleans are trusted.
            pinned: typeof session.pinned === 'boolean' ? session.pinned : undefined,
            archived: typeof session.archived === 'boolean' ? session.archived : undefined,
        };
    }
    catch (err) {
        // A missing file is normal; anything else means a corrupt session, which the
        // user should be able to see in the log instead of a bare "not found".
        const code = err?.code;
        if (code !== 'ENOENT')
            logger.error(`Failed to load session ${id}: ${err}`);
        return null;
    }
}
/** List all sessions (sorted by most recently updated). */
export async function listSessions() {
    const dir = getSessionsDir();
    let entries;
    try {
        entries = await fs.readdir(dir);
    }
    catch {
        return [];
    }
    const summaries = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        // The id must match the filename so every listed session can be deleted;
        // a stored id that differs from its filename is ignored.
        const id = entry.replace(/\.json$/, '');
        if (!isValidSessionId(id))
            continue;
        try {
            const content = await fs.readFile(path.join(dir, entry), 'utf8');
            const session = JSON.parse(content);
            const messages = Array.isArray(session.completionMessages) ? session.completionMessages : [];
            const storedTitle = typeof session.title === 'string' ? titleFromText(session.title) : '';
            summaries.push({
                id,
                // Older builds stored raw first lines (and sometimes wrapper text), so
                // fall back to the conversation when the stored title is unusable.
                title: storedTitle || generateTitle(messages, 'Untitled session'),
                createdAt: typeof session.createdAt === 'string' ? session.createdAt : '',
                updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '',
                provider: typeof session.provider === 'string' ? session.provider : undefined,
                model: typeof session.model === 'string' ? session.model : undefined,
                // The system prompt is not a message the user sent.
                messageCount: countConversationMessages(messages),
                pinned: session.pinned === true ? true : undefined,
                archived: session.archived === true ? true : undefined,
            });
        }
        catch (err) {
            // Skip corrupt session files, but leave a trace: silently dropping files
            // makes "my session disappeared" impossible to diagnose.
            logger.warn(`Skipping unreadable session file ${entry}: ${err}`);
        }
    }
    // Sort by most recently updated
    summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return summaries;
}
/** Delete a session and all of its associated in-memory state. */
export async function deleteSession(id) {
    try {
        await fs.unlink(sessionPath(id));
        // Todos are persisted inside the session JSON (removed above); this clears
        // the separate in-memory copy so a deleted session leaves nothing behind.
        clearTodos(id);
        return true;
    }
    catch {
        return false;
    }
}
/** Longest title kept in the store and in the picker. */
export const MAX_TITLE_LENGTH = 60;
/** Harness-injected wrapper that never makes a good session title. */
const TITLE_NOISE_PATTERNS = [
    /^<system-reminder>[\s\S]*?<\/system-reminder>/i,
    /^\[Image #\d+\]/i,
    /^@\S+\s*$/i,
];
/**
 * Turn one user message into a readable single-line title.
 *
 * Messages can start with harness wrappers (system reminders, image markers)
 * or span many lines, which used to produce titles like "<system-reminder>".
 * The result is always one line, trimmed at a word boundary.
 */
export function titleFromText(raw) {
    let text = raw;
    for (const pattern of TITLE_NOISE_PATTERNS)
        text = text.replace(pattern, ' ');
    // Drop fenced blocks and collapse every whitespace run (including newlines).
    text = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
    // Leading punctuation (`:`, `-`, quotes) carries no meaning in a title.
    text = text.replace(/^[\s:;,.!?'"`~^*#>-]+/, '').trim();
    if (!text)
        return '';
    if (text.length <= MAX_TITLE_LENGTH)
        return text;
    const cut = text.slice(0, MAX_TITLE_LENGTH - 1);
    const lastSpace = cut.lastIndexOf(' ');
    const stem = lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
    return `${stem.trimEnd()}…`;
}
/**
 * Generate a short title for a session from the first meaningful user message.
 *
 * `fallback` is used when the conversation has no usable text yet, so a fresh
 * or system-reminder-only session still gets a distinguishable label.
 */
export function generateTitle(messages, fallback = 'New session') {
    for (const message of messages) {
        if (message.role !== 'user')
            continue;
        const content = message.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        }
        else if (Array.isArray(content)) {
            text = content
                .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : ''))
                .join(' ');
        }
        const title = titleFromText(text);
        if (title)
            return title;
    }
    return fallback;
}
/** Messages that actually form the conversation (system prompt excluded). */
export function countConversationMessages(messages) {
    return messages.filter((message) => message.role !== 'system').length;
}
/**
 * Human "when" for a session row: `just now`, `12m ago`, `3h ago`, `2d ago`.
 * Kept dependency-free so both the TUI picker and `bitacode sessions list`
 * print the same thing.
 */
export function formatSessionAge(iso, now = Date.now()) {
    const stamp = Date.parse(iso);
    if (!Number.isFinite(stamp))
        return 'unknown';
    const seconds = Math.max(0, Math.round((now - stamp) / 1000));
    if (seconds < 60)
        return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30)
        return `${days}d ago`;
    return new Date(stamp).toISOString().slice(0, 10);
}
/* ------------------- fork / rename / pin / export ------------------- */
/**
 * Clone a saved session under a NEW id.
 *
 * The source is only read — a fresh file is written for the fork, so the
 * original is never modified. When `uptoMessageIndex` is a finite number the
 * message list is truncated to `[0, uptoMessageIndex)` (the system prompt at
 * index 0 is kept for any positive bound).
 */
export async function forkSession(id, title, uptoMessageIndex) {
    const source = await loadSession(id);
    if (!source)
        return null;
    const messages = Array.isArray(source.completionMessages)
        ? [...source.completionMessages]
        : [];
    const kept = typeof uptoMessageIndex === 'number' && Number.isFinite(uptoMessageIndex)
        ? messages.slice(0, Math.max(0, Math.min(uptoMessageIndex, messages.length)))
        : messages;
    const fork = {
        id: generateSessionId(),
        title: typeof title === 'string' && title.trim() ? title.trim() : source.title,
        // Fresh timestamps: a fork is a new session, not a copy of the old clock.
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: source.model,
        provider: source.provider,
        ...(typeof source.variant === 'string' ? { variant: source.variant } : {}),
        todos: Array.isArray(source.todos) ? source.todos.map((todo) => ({ ...todo })) : [],
        completionMessages: kept.map((message) => ({ ...message })),
        ...(source.subAgentActivities
            ? { subAgentActivities: source.subAgentActivities.map((activity) => ({ ...activity })) }
            : {}),
        ...(source.pinned === true ? { pinned: true } : {}),
        ...(source.archived === true ? { archived: true } : {}),
    };
    await saveSession(fork);
    return fork;
}
/** Rename a saved session. Returns false when the id does not resolve. */
export async function renameSession(id, title) {
    const session = await loadSession(id);
    if (!session)
        return false;
    session.title = typeof title === 'string' ? title.trim() : '';
    await saveSession(session);
    return true;
}
/** Pin or unpin a saved session. Returns false when the id does not resolve. */
export async function setSessionPinned(id, pinned) {
    const session = await loadSession(id);
    if (!session)
        return false;
    session.pinned = pinned === true;
    await saveSession(session);
    return true;
}
/** Archive or unarchive a saved session. Returns false when the id does not resolve. */
export async function setSessionArchived(id, archived) {
    const session = await loadSession(id);
    if (!session)
        return false;
    session.archived = archived === true;
    await saveSession(session);
    return true;
}
/** Turn message content (string or multimodal parts) into plain text. */
function messageContentToString(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n');
    }
    return content == null ? '' : String(content);
}
/**
 * Build a secret-free, readable transcript. System/developer instructions and
 * UI-only fields (reasoning, bitacode* metadata) are deliberately omitted — an
 * export is meant to be shared, not to leak the harness prompt or chain of thought.
 */
function exportedMessages(session) {
    const out = [];
    const messages = Array.isArray(session.completionMessages) ? session.completionMessages : [];
    for (const message of messages) {
        const raw = message;
        if (!raw || typeof raw !== 'object')
            continue;
        const role = typeof raw.role === 'string' ? raw.role : '';
        if (role === 'system' || role === 'developer')
            continue;
        let content = messageContentToString(raw.content);
        const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        for (const call of calls) {
            const name = call?.function?.name ?? call?.name ?? 'tool';
            const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
            content = content ? `${content}\n[tool call: ${name}(${args})]` : `[tool call: ${name}(${args})]`;
        }
        out.push({ role, content: content.trim() });
    }
    return out;
}
function exportMetadata(session, messageCount) {
    const meta = {
        id: session.id,
        title: session.title,
        provider: session.provider,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount,
    };
    if (session.variant)
        meta.variant = session.variant;
    if (session.pinned)
        meta.pinned = true;
    return meta;
}
/** Render a saved session for sharing. Returns null when the id does not resolve. */
export async function exportSession(id, format) {
    const session = await loadSession(id);
    if (!session)
        return null;
    const fmt = format === 'txt' || format === 'json' ? format : 'md';
    const messages = exportedMessages(session);
    const meta = exportMetadata(session, messages.length);
    const route = `${session.provider}/${session.model}`.trim();
    if (fmt === 'json') {
        return JSON.stringify({ metadata: meta, messages }, null, 2);
    }
    const header = [];
    if (fmt === 'md') {
        header.push(`# ${session.title || 'Untitled session'}`, '');
        header.push(`- ID: \`${session.id}\``);
        header.push(`- Route: ${route}`);
        if (session.variant)
            header.push(`- Variant: ${session.variant}`);
        header.push(`- Created: ${session.createdAt}`);
        header.push(`- Updated: ${session.updatedAt}`);
        if (session.pinned)
            header.push('- Pinned: yes');
        header.push(`- Messages: ${messages.length}`, '');
    }
    else {
        header.push(`Session: ${session.title || 'Untitled session'}`);
        header.push(`ID: ${session.id}`);
        header.push(`Route: ${route}`);
        if (session.variant)
            header.push(`Variant: ${session.variant}`);
        header.push(`Created: ${session.createdAt}`);
        header.push(`Updated: ${session.updatedAt}`);
        if (session.pinned)
            header.push('Pinned: yes');
        header.push(`Messages: ${messages.length}`, '');
    }
    const body = messages.map((message) => {
        const label = message.role.charAt(0).toUpperCase() + message.role.slice(1);
        const heading = fmt === 'md' ? `### ${label}` : `[${label}]`;
        return `${heading}\n${message.content || '(empty)'}`;
    });
    return [...header, '---', '', ...body].join('\n');
}

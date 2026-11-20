/**
 * sessions command — inspect, replay, and manage saved sessions.
 *
 * `replay`/`stats`/`journal` read the append-only journal (they never modify
 * anything); `fork`/`rename`/`pin`/`export` operate on the session store.
 */
import fs from 'node:fs/promises';
import process from 'node:process';
import { countConversationMessages, exportSession, forkSession, listSessions, loadSession, renameSession, setSessionPinned, } from '../sessions.js';
import { computeJournalStats, listJournals, readJournal, renderJournalReplay, } from '../utils/session-journal.js';
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export async function runSessionsCommand(args, options = {}) {
    const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    const sub = (args[0] ?? 'list').toLowerCase();
    const id = args[1];
    switch (sub) {
        case 'list': {
            const sessions = await listSessions();
            if (options.json) {
                write(JSON.stringify({ sessions }));
                return 0;
            }
            if (sessions.length === 0) {
                write('No saved sessions.');
                return 0;
            }
            for (const session of sessions.slice(0, options.limit ?? 20)) {
                const stamp = new Date(session.updatedAt ?? session.createdAt ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ');
                const count = session.messageCount ?? 0;
                const pin = session.pinned ? '📌 ' : '';
                write(`${session.id}  ${stamp}  ${count} msg${count === 1 ? '' : 's'}  ${pin}${session.title ?? '(untitled)'}`);
            }
            return 0;
        }
        case 'show': {
            if (!id) {
                write('Usage: bitacode sessions show <id>');
                return 1;
            }
            const session = await loadSession(id);
            if (!session) {
                write(`Session not found: ${id}`);
                return 1;
            }
            if (options.json) {
                write(JSON.stringify({
                    id: session.id,
                    title: session.title,
                    model: session.model,
                    provider: session.provider,
                    messageCount: countConversationMessages(session.completionMessages),
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                }));
                return 0;
            }
            write(`id: ${session.id}`);
            write(`title: ${session.title ?? '(untitled)'}`);
            write(`route: ${session.provider}/${session.model}`);
            write(`messages: ${countConversationMessages(session.completionMessages)}`);
            write(`created: ${session.createdAt}`);
            write(`updated: ${session.updatedAt}`);
            return 0;
        }
        case 'replay': {
            if (!id) {
                write('Usage: bitacode sessions replay <id>');
                return 1;
            }
            const { lines } = readJournal(id);
            if (options.json) {
                write(JSON.stringify({ id, lines }));
                return 0;
            }
            for (const line of renderJournalReplay(id, options.limit ?? 200))
                write(line);
            return 0;
        }
        case 'stats': {
            if (id) {
                const stats = computeJournalStats(id);
                if (options.json) {
                    write(JSON.stringify({ id, ...stats }));
                    return 0;
                }
                write(`session ${id}`);
                write(`  lines: ${stats.lines} (${formatBytes(stats.bytes)})`);
                write(`  user turns: ${stats.userTurns}`);
                write(`  assistant turns: ${stats.assistantTurns}`);
                write(`  tool calls: ${stats.toolCalls} (${stats.toolErrors} failed)`);
                write(`  compactions: ${stats.compactions}`);
                if (stats.startedAt)
                    write(`  started: ${stats.startedAt}`);
                if (stats.endedAt)
                    write(`  ended: ${stats.endedAt}`);
                return 0;
            }
            const journals = listJournals();
            if (options.json) {
                write(JSON.stringify({ journals }));
                return 0;
            }
            if (journals.length === 0) {
                write('No journals recorded yet.');
                return 0;
            }
            for (const journal of journals.slice(0, options.limit ?? 20)) {
                write(`${journal.sessionId}  ${formatBytes(journal.bytes)}  ${new Date(journal.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}`);
            }
            return 0;
        }
        case 'journal': {
            const journals = listJournals();
            if (options.json) {
                write(JSON.stringify({ journals }));
                return 0;
            }
            for (const journal of journals)
                write(`${journal.sessionId}  ${formatBytes(journal.bytes)}`);
            return 0;
        }
        case 'fork': {
            if (!id) {
                write('Usage: bitacode sessions fork <id> [title]');
                return 1;
            }
            const title = args.slice(2).join(' ').trim() || undefined;
            const fork = await forkSession(id, title);
            if (!fork) {
                write(`Session not found: ${id}`);
                return 1;
            }
            if (options.json) {
                write(JSON.stringify({ id: fork.id, sourceId: id, title: fork.title }));
            }
            else {
                write(`Forked ${id} -> ${fork.id}${fork.title ? ` (${fork.title})` : ''}`);
            }
            return 0;
        }
        case 'rename': {
            const title = args.slice(2).join(' ').trim();
            if (!id || !title) {
                write('Usage: bitacode sessions rename <id> <title...>');
                return 1;
            }
            if (!(await renameSession(id, title))) {
                write(`Session not found: ${id}`);
                return 1;
            }
            if (options.json)
                write(JSON.stringify({ id, title }));
            else
                write(`Renamed ${id} -> ${title}`);
            return 0;
        }
        case 'pin': {
            if (!id) {
                write('Usage: bitacode sessions pin <id> [on|off]');
                return 1;
            }
            const state = (args[2] ?? 'on').toLowerCase();
            if (state !== 'on' && state !== 'off') {
                write('Usage: bitacode sessions pin <id> [on|off]');
                return 1;
            }
            const pinned = state === 'on';
            if (!(await setSessionPinned(id, pinned))) {
                write(`Session not found: ${id}`);
                return 1;
            }
            if (options.json)
                write(JSON.stringify({ id, pinned }));
            else
                write(`Session ${id} ${pinned ? 'pinned' : 'unpinned'}`);
            return 0;
        }
        case 'export': {
            if (!id) {
                write('Usage: bitacode sessions export <id> [md|txt|json] [--out <file>]');
                return 1;
            }
            const rest = args.slice(2);
            let outFile;
            const formatTokens = [];
            for (let i = 0; i < rest.length; i++) {
                const token = rest[i];
                if (token === '--out') {
                    outFile = rest[++i];
                    if (!outFile) {
                        write('Usage: bitacode sessions export <id> [md|txt|json] [--out <file>]');
                        return 1;
                    }
                }
                else if (token.startsWith('--out=')) {
                    outFile = token.slice('--out='.length);
                    if (!outFile) {
                        write('Usage: bitacode sessions export <id> [md|txt|json] [--out <file>]');
                        return 1;
                    }
                }
                else {
                    formatTokens.push(token);
                }
            }
            const format = (formatTokens[0] ?? 'md').toLowerCase();
            if (format !== 'md' && format !== 'txt' && format !== 'json') {
                write(`Unknown export format: ${format}`);
                write('Usage: bitacode sessions export <id> [md|txt|json] [--out <file>]');
                return 1;
            }
            const content = await exportSession(id, format);
            if (content === null) {
                write(`Session not found: ${id}`);
                return 1;
            }
            if (outFile) {
                try {
                    await fs.writeFile(outFile, content, 'utf8');
                }
                catch (err) {
                    write(`Failed to write ${outFile}: ${err}`);
                    return 1;
                }
                if (options.json)
                    write(JSON.stringify({ id, format, out: outFile }));
                else
                    write(`Exported session ${id} to ${outFile} (${format})`);
                return 0;
            }
            write(content);
            return 0;
        }
        default:
            write(`Unknown sessions subcommand: ${sub}`);
            write('Usage: bitacode sessions [list|show <id>|replay <id>|stats [id]|journal|fork <id> [title]|rename <id> <title...>|pin <id> [on|off]|export <id> [md|txt|json] [--out <file>]]');
            return 1;
    }
}

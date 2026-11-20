/**
 * Process tools — start/poll/write/stop long-running background commands.
 *
 * Processes are spawned detached with piped stdio and kept in a module-level
 * map. Unlike the `bash` tool, the child is NOT killed when the tool returns;
 * callers poll it and explicitly stop it.
 */
import { spawn } from 'node:child_process';
import { gateCommand } from '../utils/command-gate.js';
import { logger } from '../utils/logger.js';
const MAX_PROCESSES = 16;
const MAX_BUFFER_CHARS = 200_000;
const CLEANUP_DELAY_MS = 60_000;
const processes = new Map();
let nextId = 1;
export const startProcessTool = {
    type: 'function',
    function: {
        name: 'start_process',
        description: 'Start a background process with piped stdin/stdout/stderr and return an id. ' +
            'The process keeps running after this tool returns; use poll_process to read output.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to run in the background.' },
                cwd: {
                    type: 'string',
                    description: 'Working directory for the process. Must be within the allowed roots. Defaults to the current directory.',
                },
            },
            required: ['command'],
        },
    },
};
export const pollProcessTool = {
    type: 'function',
    function: {
        name: 'poll_process',
        description: 'Return output produced since the last poll plus running status and exit code for a background process.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id returned by start_process.' },
            },
            required: ['id'],
        },
    },
};
export const writeProcessStdinTool = {
    type: 'function',
    function: {
        name: 'write_process_stdin',
        description: 'Write text to the stdin of a running background process.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id returned by start_process.' },
                data: { type: 'string', description: 'Text to write to stdin.' },
            },
            required: ['id', 'data'],
        },
    },
};
export const stopProcessTool = {
    type: 'function',
    function: {
        name: 'stop_process',
        description: 'Stop a background process by killing its process group.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id returned by start_process.' },
            },
            required: ['id'],
        },
    },
};
function killTree(child, signal) {
    if (process.platform === 'win32') {
        if (child.pid) {
            const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            taskkill.on('error', () => {
                try {
                    child.kill(signal);
                }
                catch { /* already gone */ }
            });
        }
        return;
    }
    if (!child.pid)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch { /* already gone */ }
    }
}
function appendOutput(entry, chunk) {
    entry.pending += String(chunk);
    if (entry.pending.length > MAX_BUFFER_CHARS) {
        const excess = entry.pending.length - MAX_BUFFER_CHARS;
        entry.pending = entry.pending.slice(excess);
        entry.dropped += excess;
    }
}
export async function startProcess(command, sessionId, cwd, assumeApproved = false) {
    // Same three layers as `bash`: hard block, path sandbox, approval. The
    // previous prefix allowlist ran `cat ~/.ssh/id_rsa` unapproved.
    const gate = await gateCommand({
        command,
        cwd,
        sessionId,
        approvalType: 'shell_command',
        detail: 'Background process',
        assumeApproved,
    });
    if (!gate.ok)
        return gate.reason;
    // Evict finished processes first; only refuse when all slots are live.
    if (processes.size >= MAX_PROCESSES) {
        const finished = [...processes.values()]
            .filter((entry) => !entry.running)
            .sort((a, b) => a.startedAt - b.startedAt);
        if (finished.length > 0)
            processes.delete(finished[0].id);
    }
    if (processes.size >= MAX_PROCESSES) {
        return `Error: too many running processes (limit ${MAX_PROCESSES}). Stop one before starting another.`;
    }
    const id = `proc-${nextId++}`;
    let child;
    try {
        child = spawn(command, [], {
            shell: true,
            cwd: gate.cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            // Own process group so stop_process can kill grandchildren too.
            ...(process.platform === 'win32' ? {} : { detached: true }),
        });
    }
    catch (err) {
        return `Error starting process: ${err.message}`;
    }
    ensureExitHook();
    const entry = {
        id, command, child, pending: '', dropped: 0, running: true,
        exitCode: null, signal: null, error: null, startedAt: Date.now(),
    };
    processes.set(id, entry);
    child.stdout?.on('data', (data) => appendOutput(entry, data));
    child.stderr?.on('data', (data) => appendOutput(entry, data));
    child.stdin?.on('error', () => { });
    child.on('error', (err) => {
        entry.running = false;
        entry.error = err.message;
        appendOutput(entry, `\n[process error: ${err.message}]`);
    });
    child.on('close', (code, signal) => {
        entry.running = false;
        entry.exitCode = code;
        entry.signal = signal;
        // Keep the finished entry around briefly so its final output/exit code can
        // be polled, then clean it up automatically.
        const timer = setTimeout(() => {
            if (!entry.running)
                processes.delete(id);
        }, CLEANUP_DELAY_MS);
        timer.unref?.();
    });
    return `Started process ${id}: ${command}`;
}
export function pollProcess(id) {
    const entry = typeof id === 'string' ? processes.get(id) : undefined;
    if (!entry)
        return `Error: unknown process id '${id}'.`;
    const prefix = entry.dropped > 0 ? `[... ${entry.dropped} chars of output dropped (buffer cap)]\n` : '';
    const output = prefix + entry.pending;
    entry.pending = '';
    entry.dropped = 0;
    const status = entry.running
        ? 'running'
        : `exited (code ${entry.exitCode ?? 'null'}, signal ${entry.signal ?? 'none'})${entry.error ? `, error: ${entry.error}` : ''}`;
    return `Process ${entry.id} (${entry.command}) — ${status}\noutput:\n${output || '(no new output)'}`;
}
export function writeProcessStdin(id, data) {
    const entry = typeof id === 'string' ? processes.get(id) : undefined;
    if (!entry)
        return `Error: unknown process id '${id}'.`;
    if (!entry.running)
        return `Error: process ${id} is not running.`;
    if (typeof data !== 'string')
        return 'Error: data must be a string.';
    try {
        entry.child.stdin?.write(data);
        return `Wrote ${data.length} chars to stdin of ${id}.`;
    }
    catch (err) {
        return `Error writing to stdin of ${id}: ${err.message}`;
    }
}
let exitHookInstalled = false;
/**
 * Children are spawned detached, so they outlive the TUI unless something kills
 * them. Register on the first spawn; the handler must stay synchronous, which
 * SIGTERM-only teardown is.
 */
function ensureExitHook() {
    if (exitHookInstalled)
        return;
    exitHookInstalled = true;
    process.once('exit', () => {
        stopAllProcesses();
    });
}
/**
 * Kill every managed process and its group. Called from the exit cleanup so a
 * quit does not leave `npm run dev` or a watcher running with no handle.
 */
export function stopAllProcesses() {
    let stopped = 0;
    for (const entry of processes.values()) {
        if (entry.running) {
            killTree(entry.child, 'SIGTERM');
            stopped++;
        }
    }
    if (stopped > 0)
        logger.debug(`Stopped ${stopped} background process(es) on exit`);
    processes.clear();
    return stopped;
}
export function stopProcess(id) {
    const entry = typeof id === 'string' ? processes.get(id) : undefined;
    if (!entry)
        return `Error: unknown process id '${id}'.`;
    if (!entry.running) {
        processes.delete(id);
        return `Process ${id} had already exited.`;
    }
    killTree(entry.child, 'SIGTERM');
    const timer = setTimeout(() => killTree(entry.child, 'SIGKILL'), 2000);
    timer.unref?.();
    processes.delete(id);
    return `Sent stop signal to process ${id}.`;
}

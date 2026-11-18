/**
 * Process tools — start/poll/write/stop long-running background commands.
 *
 * Processes are spawned detached with piped stdio and kept in a module-level
 * map. Unlike the `bash` tool, the child is NOT killed when the tool returns;
 * callers poll it and explicitly stop it.
 */
import { spawn } from 'node:child_process';
import { requestApproval } from '../utils/approval.js';
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
// Minimal copy of bash's safe-command pattern: obvious read-only commands skip
// approval, everything else (and anything with shell control characters) does not.
const CONTROL_PATTERN = /[;&|<>()`$[\]]{}!]/;
const DANGEROUS_PATTERNS = ['mkfs', 'dd if=', ':(){ :|:& };:'];
const SAFE_COMMANDS = [
    'pwd', 'whoami', 'date', 'uname', 'uptime',
    'git status', 'git log', 'git diff', 'git branch',
    'node --version', 'npm --version', 'ls', 'cat', 'echo', 'sleep',
];
function isSafe(command) {
    const trimmed = command.trim();
    if (!trimmed || CONTROL_PATTERN.test(trimmed) || trimmed.includes('\n') || trimmed.includes('\r')) {
        return false;
    }
    const lower = trimmed.toLowerCase();
    if (/(^|[;&|]\s*)(sudo|su)\b/.test(lower))
        return false;
    if (DANGEROUS_PATTERNS.some((pattern) => lower.includes(pattern)))
        return false;
    return SAFE_COMMANDS.some((safe) => trimmed === safe || trimmed.startsWith(`${safe} `));
}
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
export async function startProcess(command, sessionId) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return 'Error: command is required.';
    }
    if (!(await isSafe(command))) {
        const approved = await requestApproval({
            id: `start-process-${Date.now()}`,
            type: 'shell_command',
            description: `Start background process: ${command}`,
            detail: `Working directory: ${process.cwd()}\nCommand: ${command}`,
            sessionId,
            sessionScopeKey: `shell:${command}`,
        });
        if (!approved)
            return `Command cancelled by user: ${command}`;
    }
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
            cwd: process.cwd(),
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            // Own process group so stop_process can kill grandchildren too.
            ...(process.platform === 'win32' ? {} : { detached: true }),
        });
    }
    catch (err) {
        return `Error starting process: ${err.message}`;
    }
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

/**
 * bash tool — Execute shell commands with security controls.
 *
 * Three-tier security model:
 *  1. Hard-blocked dangerous commands (cannot be overridden)
 *  2. Auto-approved safe commands (read-only / info commands)
 *  3. Everything else requires user approval
 */
import { spawn } from 'node:child_process';
import { gateCommand } from '../utils/command-gate.js';
import { logger } from '../utils/logger.js';
export const bashTool = {
    type: 'function',
    function: {
        name: 'bash',
        description: 'Execute a shell command. Safe commands (ls, grep, git status, etc.) run automatically. ' +
            'Other commands require user approval. Some dangerous commands are blocked entirely.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000 (30s).' },
                cwd: { type: 'string', description: 'Working directory for the command. Must be within the allowed roots. Defaults to the current directory.' },
            },
            required: ['command'],
        },
    },
};
// Cap captured output so a runaway command cannot exhaust memory. The final
// result is trimmed further before it goes back to the model.
const MAX_CAPTURE_CHARS = 200_000;
function appendCaptured(current, chunk) {
    if (current.length >= MAX_CAPTURE_CHARS)
        return current;
    return current + chunk.slice(0, MAX_CAPTURE_CHARS - current.length);
}
export async function runBash(command, timeoutMs = 30_000, sessionId, abortSignal, cwd) {
    if (typeof command !== 'string' || command.trim().length === 0) {
        return 'Error: command is required.';
    }
    const requestedTimeout = Number(timeoutMs);
    const effectiveTimeout = Number.isFinite(requestedTimeout)
        ? Math.min(Math.max(requestedTimeout, 1000), 600_000)
        : 30_000;
    // All three layers (hard block, path sandbox, approval) live in one module so
    // bash, start_process, background and watch cannot drift apart again.
    const gate = await gateCommand({ command, cwd, sessionId, approvalType: 'shell_command' });
    if (!gate.ok) {
        return gate.reason;
    }
    const effectiveCwd = gate.cwd;
    logger.debug(`Executing: ${command}`);
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let stdoutChars = 0;
        let stderrChars = 0;
        let timedOut = false;
        let aborted = false;
        const child = spawn(command, [], {
            shell: true,
            cwd: effectiveCwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            // On POSIX, give the command its own process group so timeout/abort can
            // stop grandchildren too (a killed shell otherwise leaves them running).
            ...(process.platform === 'win32' ? {} : { detached: true }),
        });
        child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdoutChars += chunk.length;
            stdout = appendCaptured(stdout, chunk);
        });
        child.stderr?.on('data', (data) => {
            const chunk = data.toString();
            stderrChars += chunk.length;
            stderr = appendCaptured(stderr, chunk);
        });
        let killTimer = null;
        const killTree = (signal) => {
            if (process.platform === 'win32') {
                if (child.pid) {
                    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                    taskkill.on('error', () => {
                        // taskkill is best-effort; fall back to the direct child signal.
                        try {
                            child.kill('SIGTERM');
                        }
                        catch {
                            // Process already gone.
                        }
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
                catch {
                    // Process already gone.
                }
            }
        };
        const terminateChild = () => {
            if (killTimer)
                clearTimeout(killTimer);
            killTree('SIGTERM');
            killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
        };
        const onAbort = () => {
            aborted = true;
            terminateChild();
        };
        if (abortSignal?.aborted) {
            onAbort();
        }
        else {
            abortSignal?.addEventListener('abort', onAbort, { once: true });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            terminateChild();
        }, effectiveTimeout);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            abortSignal?.removeEventListener('abort', onAbort);
            if (aborted) {
                resolve(`Command aborted by user.\nPartial stdout:\n${stdout.slice(0, 5000)}\nPartial stderr:\n${stderr.slice(0, 2000)}`);
                return;
            }
            if (timedOut) {
                resolve(`Command timed out after ${effectiveTimeout / 1000}s.\nPartial stdout:\n${stdout.slice(0, 5000)}\nPartial stderr:\n${stderr.slice(0, 2000)}`);
                return;
            }
            // Truncate very long output
            const maxLen = 50_000;
            const truncatedStdout = stdoutChars > maxLen
                ? stdout.slice(0, maxLen) + `\n... (output truncated, ${stdoutChars} chars total)`
                : stdout;
            const truncatedStderr = stderrChars > 5_000
                ? stderr.slice(0, 5_000) + `\n... (stderr truncated, ${stderrChars} chars total)`
                : stderr;
            if (code === 0) {
                let output = truncatedStdout;
                if (truncatedStderr.trim()) {
                    output += `${output ? '\n' : ''}stderr:\n${truncatedStderr}`;
                }
                resolve(output || '(command completed successfully with no output)');
            }
            else {
                resolve(`Command exited with code ${code}.\nstdout:\n${truncatedStdout}\nstderr:\n${truncatedStderr}`);
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            abortSignal?.removeEventListener('abort', onAbort);
            resolve(`Error executing command: ${err.message}`);
        });
    });
}

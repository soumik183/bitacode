/**
 * Single command gate shared by `bash`, `start_process`, `background` and `watch`.
 *
 * These tools used to each carry their own copy of "is this command safe", and
 * the copies drifted: `bash` validated every path token, while the process tools
 * only matched a command prefix and then ran the string through a shell, so
 * `start_process: cat ~/.ssh/id_rsa` executed with no approval and no path check.
 *
 * Three-tier model, unchanged from the original `bash` tool:
 *  1. Hard-blocked commands (cannot be overridden, not even by yolo mode)
 *  2. Auto-approved read-only commands, after path validation
 *  3. Everything else asks the user
 */
import path from 'node:path';
import { isDangerouslySkipPermissions, requestApproval } from './approval.js';
import { logger } from './logger.js';
import { validatePath } from './path-validation.js';
// Security: Hard-blocked commands — these CANNOT be run, even with --dangerously-skip-permissions
// Naive approach: Allow any command with user approval
// Risk: Some commands are too destructive even with approval (rm -rf /, mkfs)
const DANGEROUS_PATTERNS = [
    'chmod 777',
    'dd if=',
    'mkfs',
    'fdisk',
    'format c:',
    '> /dev/sda', // Disk overwrite
    'of=/dev/sda', // dd to disk
    ':(){ :|:& };:', // Fork bomb
];
// Targets that delete the entire project / home / filesystem when combined with rm -rf.
const CATASTROPHIC_RM_TARGETS = new Set(['/', '/*', '~', '~/*', '$home', '$home/*']);
// Security: Allowlist approach for safe commands
// Naive approach: Blocklist of dangerous patterns - easily bypassed
// Bypass examples: 's\udo', '$(which sudo)', '/bin/rm', 'sh -c "rm -rf /"'
// Fix: Allowlist - only these specific commands run without approval
const SAFE_COMMANDS = [
    'pwd', 'whoami', 'date', 'uname', 'uptime',
    'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote -v',
    'npm list', 'npm ls', 'yarn list',
    'node --version', 'npm --version', 'python --version', 'python3 --version',
    'which', 'type',
];
// Security: Stricter shell control pattern to catch bypass attempts
// Naive approach: Simple regex misses many bypasses
// Bypasses: Newlines, encoded chars, quoted operators, backticks
// Note: `[` and `]` are intentionally absent — they made `ls -la [a-z]*` and
// `grep 'foo[0-9]'` look dangerous while adding no real protection.
const SHELL_CONTROL_PATTERN = /[;&|<>()`${}]/;
// Commands that read files - require path validation
const FILE_READING_COMMANDS = new Set([
    'cat', 'head', 'tail', 'grep', 'rg', 'find', 'awk', 'sed', 'sort', 'uniq',
    'cut', 'wc', 'tree', 'file', 'dir', 'ls', 'echo',
]);
export function isDangerousCommand(command) {
    // Strip quotes and collapse whitespace so "rm -rf   '/'", "sudo" tricks, etc. still match.
    const lower = command.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
    // Privileged commands are only dangerous as the command word, not in an argument.
    if (/(^|[;&|]\s*)(sudo|su)\b/.test(lower)) {
        return true;
    }
    if (DANGEROUS_PATTERNS.some((p) => lower.includes(p))) {
        return true;
    }
    // rm -rf / (and ~ or $HOME) in any flag order
    if (/\brm\b/.test(lower)) {
        const tokens = lower.split(' ');
        const flags = tokens.filter((t) => t.startsWith('-')).join('');
        const targets = tokens.filter((t) => !t.startsWith('-') && t !== 'rm');
        const recursive = flags.includes('r') || flags.includes('recursive');
        const force = flags.includes('f') || flags.includes('force');
        if (recursive && force && targets.some((t) => CATASTROPHIC_RM_TARGETS.has(t))) {
            return true;
        }
    }
    return false;
}
export function hasShellControlOperators(command) {
    return SHELL_CONTROL_PATTERN.test(command);
}
export function tokenizeCommand(command) {
    const tokens = command.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g);
    return tokens && tokens.length > 0 ? tokens : null;
}
function stripOuterQuotes(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function looksLikePath(token) {
    if (!token)
        return false;
    if (token === '.' || token === '..')
        return true;
    if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~/')) {
        return true;
    }
    return token.includes(path.sep) || /\.[A-Za-z0-9_-]+$/.test(token);
}
/**
 * Validate every path-looking token, including the command word itself: a bare
 * `/usr/bin/env` or `../evil.sh` as argv[0] escaped validation before.
 */
export async function validateCommandPaths(tokens) {
    for (let index = 0; index < tokens.length; index++) {
        // Flag values like `--prefix=/tmp/x` are still paths; check the value side.
        const raw = tokens[index];
        const stripped = stripOuterQuotes(raw);
        const candidates = [stripped];
        const eq = stripped.indexOf('=');
        if (eq > 0)
            candidates.push(stripped.slice(eq + 1));
        for (const token of candidates) {
            if (!looksLikePath(token))
                continue;
            if (token.startsWith('~'))
                return false;
            try {
                await validatePath(token);
            }
            catch {
                return false;
            }
        }
    }
    return true;
}
export async function isSafeCommand(command) {
    const trimmed = command.trim();
    if (!trimmed || hasShellControlOperators(trimmed)) {
        return false;
    }
    // Security: Reject commands with newlines (bypass technique)
    if (trimmed.includes('\n') || trimmed.includes('\r')) {
        return false;
    }
    // Security: Reject escape sequences that could hide shell operators
    if (/\\[;&|<>()`$]/.test(trimmed)) {
        return false;
    }
    const tokens = tokenizeCommand(trimmed);
    if (!tokens) {
        return false;
    }
    const firstWord = trimmed.split(/\s+/)[0];
    // Security: File-reading commands need path validation
    // They can read any file in working directory but not outside
    const needsPathValidation = FILE_READING_COMMANDS.has(firstWord);
    // Check against allowlist of safe commands
    const matchedSafeCommand = SAFE_COMMANDS.some((safe) => {
        if (safe.includes(' ')) {
            return trimmed === safe || trimmed.startsWith(`${safe} `);
        }
        return firstWord === safe;
    });
    if (!matchedSafeCommand && !needsPathValidation) {
        return false;
    }
    // Security: Always validate paths for file-reading commands
    if (needsPathValidation) {
        return validateCommandPaths(tokens);
    }
    return true;
}
/**
 * Run every security layer for a command and return where it may run.
 * The caller only has to spawn; it can no longer forget a check.
 */
export async function gateCommand(options) {
    const command = options.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
        return { ok: false, reason: 'Error: command is required.' };
    }
    // Layer 1: hard block — runs before any approval mode, so approval can never bypass it.
    if (isDangerousCommand(command)) {
        return {
            ok: false,
            blocked: true,
            reason: `Error: Command blocked for safety. "${command}" contains a dangerous pattern that cannot be executed.`,
        };
    }
    // Per-call cwd is validated like any other path; default to the process cwd.
    let cwd;
    try {
        cwd = await validatePath(options.cwd ?? process.cwd());
    }
    catch (err) {
        return { ok: false, reason: `Error: Invalid working directory. ${err.message}` };
    }
    // Execution-time path enforcement. Approval routing used to be the only place
    // paths were checked, which meant auto mode never enforced them. yolo /
    // --dangerously-skip-permissions is the intentional escape hatch for path
    // restrictions ONLY — the dangerous-command block above still always applies.
    if (!isDangerouslySkipPermissions()) {
        const tokens = tokenizeCommand(command);
        if (!tokens || !(await validateCommandPaths(tokens))) {
            return {
                ok: false,
                reason: `Command blocked: "${command}" references a path outside the allowed working directory.`,
            };
        }
    }
    // Layer 2: safe commands skip approval
    if (options.assumeApproved || (await isSafeCommand(command))) {
        return { ok: true, cwd, requiresApproval: false };
    }
    // Layer 3: interactive approval
    const approved = await requestApproval({
        id: `${options.approvalType ?? 'shell_command'}-${Date.now()}`,
        type: options.approvalType ?? 'shell_command',
        description: `Run command: ${command}`,
        detail: `Working directory: ${cwd}\nCommand: ${command}${options.detail ? `\n${options.detail}` : ''}`,
        sessionId: options.sessionId,
        sessionScopeKey: `shell:${cwd}:${command}`,
    });
    if (!approved) {
        logger.debug('Command cancelled by user', { command });
        return { ok: false, reason: `Command cancelled by user: ${command}` };
    }
    return { ok: true, cwd, requiresApproval: true, approved: true };
}

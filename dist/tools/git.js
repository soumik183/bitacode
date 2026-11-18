/**
 * Structured git tools. Only fixed, allowlisted argument sets are passed to
 * `git` via execFile — no arbitrary subcommands or flags reach the process.
 * Read-only commands run freely; mutating ones require shell_command approval.
 */
import { execFile } from 'node:child_process';
import { requestApproval } from '../utils/approval.js';
export const gitStatusTool = {
    type: 'function',
    function: {
        name: 'git_status',
        description: 'Show the working tree status. Read-only; does not require approval.',
        parameters: {
            type: 'object',
            properties: {
                short: { type: 'boolean', description: 'Use short (porcelain) output.' },
            },
            required: [],
        },
    },
};
export const gitDiffTool = {
    type: 'function',
    function: {
        name: 'git_diff',
        description: 'Show unstaged or staged changes as a unified diff (or --stat). Read-only.',
        parameters: {
            type: 'object',
            properties: {
                staged: { type: 'boolean', description: 'Show staged changes instead of unstaged.' },
                stat: { type: 'boolean', description: 'Show a diffstat instead of the full patch.' },
            },
            required: [],
        },
    },
};
export const gitAddTool = {
    type: 'function',
    function: {
        name: 'git_add',
        description: 'Stage file paths (or all changes) with git add. Requires approval.',
        parameters: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage.' },
                all: { type: 'boolean', description: 'Stage all changes (git add -A).' },
            },
            required: [],
        },
    },
};
export const gitCommitTool = {
    type: 'function',
    function: {
        name: 'git_commit',
        description: 'Commit staged changes with a message (optionally --amend). Requires approval.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Commit message.' },
                amend: { type: 'boolean', description: 'Amend the previous commit instead.' },
            },
            required: ['message'],
        },
    },
};
export const gitStashTool = {
    type: 'function',
    function: {
        name: 'git_stash',
        description: 'Stash operations: push/pop/list/apply/drop. Requires approval.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['push', 'pop', 'list', 'apply', 'drop'],
                    description: 'Stash action (default: push).',
                },
                message: { type: 'string', description: 'Optional message for push.' },
            },
            required: [],
        },
    },
};
function runGit(args) {
    return new Promise((resolve) => {
        execFile('git', args, { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err
                ? (typeof err.code === 'number' ? err.code : 1)
                : 0;
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
        });
    });
}
const MAX_GIT_OUTPUT = 20_000;
/** Keep head and tail so errors at the end of git output are not lost. */
function concise(output) {
    if (output.length <= MAX_GIT_OUTPUT)
        return output;
    const marker = '\n… git output truncated …\n';
    const budget = MAX_GIT_OUTPUT - marker.length;
    const head = Math.ceil(budget * 0.4);
    return `${output.slice(0, head)}${marker}${output.slice(output.length - (budget - head))}`;
}
function formatResult(args, result) {
    let out = result.stdout;
    if (result.stderr.trim()) {
        out += `${out && !out.endsWith('\n') ? '\n' : ''}${out ? 'stderr:\n' : ''}${result.stderr}`;
    }
    const body = concise(out.trim() || '(no output)');
    const command = `$ git ${args.join(' ')}`;
    return result.code === 0 ? `${command}\n${body}` : `${command} (exit ${result.code})\n${body}`;
}
async function approve(args, description, sessionId) {
    return requestApproval({
        id: `git-${Date.now()}-${args.join('-')}`,
        type: 'shell_command',
        description,
        detail: `Working directory: ${process.cwd()}\n$ git ${args.join(' ')}`,
        sessionId,
        sessionScopeKey: `shell:git ${args.join(' ')}`,
    });
}
export async function gitStatus(short = false) {
    const args = short ? ['status', '--short'] : ['status'];
    return formatResult(args, await runGit(args));
}
export async function gitDiff(staged = false, stat = false) {
    const args = ['diff'];
    if (staged)
        args.push('--cached');
    if (stat)
        args.push('--stat');
    return formatResult(args, await runGit(args));
}
export async function gitAdd(paths, all, sessionId) {
    let args;
    if (all === true) {
        args = ['add', '-A'];
    }
    else {
        if (!Array.isArray(paths) || paths.length === 0) {
            return 'Error: paths is required (an array of file paths), or set all=true.';
        }
        if (paths.some((p) => typeof p !== 'string' || !p || p.startsWith('-') || p.includes('\0'))) {
            return 'Error: invalid path in paths (empty, flag-like, or contains a null byte).';
        }
        args = ['add', ...paths];
    }
    if (!(await approve(args, 'Stage files with git add', sessionId))) {
        return 'Command cancelled by user: git add.';
    }
    return formatResult(args, await runGit(args));
}
export async function gitCommit(message, amend, sessionId) {
    if (typeof message !== 'string' || message.trim().length === 0) {
        return 'Error: commit message is required.';
    }
    const args = ['commit', '-m', message];
    if (amend === true)
        args.push('--amend');
    if (!(await approve(args, `Commit with message: ${message}`, sessionId))) {
        return 'Command cancelled by user: git commit.';
    }
    return formatResult(args, await runGit(args));
}
export async function gitStash(action, message, sessionId) {
    const allowed = ['push', 'pop', 'list', 'apply', 'drop'];
    const act = typeof action === 'string' && action ? action : 'push';
    if (!allowed.includes(act)) {
        return `Error: invalid stash action '${act}'. Allowed: ${allowed.join(', ')}.`;
    }
    const args = ['stash', act];
    if (act === 'push' && typeof message === 'string' && message.trim().length > 0) {
        args.push('-m', message);
    }
    if (!(await approve(args, `git stash ${act}`, sessionId))) {
        return `Command cancelled by user: git stash ${act}.`;
    }
    return formatResult(args, await runGit(args));
}

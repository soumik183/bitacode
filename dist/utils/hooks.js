/**
 * hooks.ts — user-defined lifecycle hooks.
 *
 * Four events, deliberately few:
 *
 *   SessionStart      once per session; output becomes context
 *   UserPromptSubmit  before a turn is sent; exit 2 rejects the prompt
 *   PreToolUse        before a tool runs; exit 2 blocks that call
 *   PostToolUse       after a tool runs; output is appended to the result
 *
 * A hook is a shell command that receives one JSON object on stdin and may print
 * one JSON object on stdout:
 *
 *   { "decision": "block", "reason": "..." }          // block
 *   { "hookSpecificOutput": { "additionalContext": "..." } }
 *   { "systemMessage": "..." }
 *
 * Exit codes: 0 ok, 2 block (stderr is the reason), anything else is a warning.
 * For the two blocking events a spawn failure or timeout also blocks: a hook that
 * cannot run must never silently pass.
 *
 * Project hooks (`<repo>/.bitacode/hooks.json`) only load when the project is
 * trusted, so opening a cloned repository cannot execute its code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from './logger.js';
export const HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
];
export const BLOCKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse']);
const DEFAULT_TIMEOUT_MS = 10_000;
const BLOCKING_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 32 * 1024;
function isEventName(value) {
    return typeof value === 'string' && HOOK_EVENTS.includes(value);
}
function normalizeTimeout(value, event) {
    const fallback = BLOCKING_EVENTS.has(event) ? BLOCKING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.min(value, MAX_TIMEOUT_MS);
}
function matcherRegExp(matcher) {
    const body = matcher
        .split('|')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split('*').map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
        .join('|');
    return new RegExp(`^(?:${body || '.*'})$`, 'i');
}
/**
 * Parse one hooks config. Accepts both the flat form
 * `{ "PreToolUse": [ ... ] }` and Claude's nested form
 * `{ "hooks": { "PreToolUse": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }`.
 */
export function parseHookConfig(raw, source) {
    const errors = [];
    const hooks = [];
    if (!raw || typeof raw !== 'object') {
        return { hooks, errors: [`${source}: expected an object`], files: [source] };
    }
    const root = raw;
    const nested = root.hooks && typeof root.hooks === 'object' ? root.hooks : root;
    for (const [key, value] of Object.entries(nested)) {
        if (!isEventName(key)) {
            if (key !== 'version' && key !== '$schema')
                errors.push(`${source}: unknown hook event "${key}"`);
            continue;
        }
        if (!Array.isArray(value)) {
            errors.push(`${source}: ${key} must be an array`);
            continue;
        }
        for (const entry of value) {
            if (typeof entry === 'string') {
                if (!entry.trim()) {
                    errors.push(`${source}: empty ${key} hook`);
                    continue;
                }
                hooks.push({
                    event: key,
                    command: entry.trim(),
                    timeoutMs: normalizeTimeout(undefined, key),
                    source,
                });
                continue;
            }
            if (!entry || typeof entry !== 'object') {
                errors.push(`${source}: ${key} entry must be a command string or an object`);
                continue;
            }
            const item = entry;
            const matcher = typeof item.matcher === 'string' ? item.matcher : undefined;
            const timeoutMs = normalizeTimeout(item.timeout ?? item.timeoutMs, key);
            // Nested command list form: { matcher, hooks: [{ type, command }] }
            if (Array.isArray(item.hooks)) {
                for (const inner of item.hooks) {
                    if (!inner || typeof inner !== 'object')
                        continue;
                    const command = inner.command;
                    if (typeof command !== 'string' || !command.trim()) {
                        errors.push(`${source}: ${key} hook is missing a command`);
                        continue;
                    }
                    hooks.push({ event: key, command: command.trim(), matcher, timeoutMs, source });
                }
                continue;
            }
            if (typeof item.command !== 'string' || !item.command.trim()) {
                errors.push(`${source}: ${key} hook is missing a command`);
                continue;
            }
            hooks.push({ event: key, command: item.command.trim(), matcher, timeoutMs, source });
        }
    }
    return { hooks, errors, files: [source] };
}
function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function userHooksPath() {
    const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
    return path.join(configHome, 'bitacode', 'hooks.json');
}
function projectHooksPath(cwd) {
    return path.join(cwd, '.bitacode', 'hooks.json');
}
/** Load user hooks plus project hooks (the latter only when trusted). */
export function loadHooks(options, extraHooks = []) {
    const result = { hooks: [], errors: [], files: [] };
    const candidates = [options.userFile ?? userHooksPath()];
    if (options.trusted)
        candidates.push(options.projectFile ?? projectHooksPath(options.cwd));
    for (const file of candidates) {
        let parsed;
        try {
            const raw = readJson(file);
            parsed = parseHookConfig(raw, file);
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                result.errors.push(`${file}: ${String(err instanceof Error ? err.message : err)}`);
            }
            continue;
        }
        result.hooks.push(...parsed.hooks);
        result.errors.push(...parsed.errors);
        result.files.push(file);
    }
    if (!options.trusted) {
        const projectFile = options.projectFile ?? projectHooksPath(options.cwd);
        if (fs.existsSync(projectFile)) {
            result.errors.push(`${projectFile}: ignored because this project is not trusted (run: bitacode permissions trust)`);
        }
    }
    // Plugin-provided hooks are appended, never replacing the loaded ones.
    if (extraHooks.length > 0)
        result.hooks.push(...extraHooks);
    return result;
}
export function hooksForEvent(hooks, event, toolName) {
    return hooks.filter((hook) => {
        if (hook.event !== event)
            return false;
        if (!hook.matcher)
            return true;
        if (!toolName)
            return true;
        return matcherRegExp(hook.matcher).test(toolName);
    });
}
function runOneHook(hook, payload, cwd, spawnFn, env) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        let child;
        try {
            child = spawnFn(hook.command, {
                cwd,
                env: { ...env, BITACODE_HOOK_EVENT: hook.event },
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            resolve({
                code: null,
                stdout: '',
                stderr: '',
                timedOut: false,
                spawnError: String(err instanceof Error ? err.message : err),
            });
            return;
        }
        let stdout = '';
        let stderr = '';
        const append = (current, chunk) => {
            if (current.length >= MAX_OUTPUT_CHARS)
                return current;
            return (current + String(chunk)).slice(0, MAX_OUTPUT_CHARS);
        };
        child.stdout?.on('data', (chunk) => {
            stdout = append(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = append(stderr, chunk);
        });
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                // ignore
            }
            finish({ code: null, stdout, stderr, timedOut: true });
        }, hook.timeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        child.on('error', (err) => {
            finish({ code: null, stdout, stderr, timedOut: false, spawnError: err.message });
        });
        child.on('close', (code) => {
            finish({ code, stdout, stderr, timedOut: false });
        });
        // A hook that exits immediately closes stdin first; writing after that
        // raises EPIPE asynchronously, so the stream needs its own error handler.
        child.stdin?.on('error', () => {
            // Hook does not read stdin: not an error.
        });
        try {
            child.stdin?.end(`${JSON.stringify(payload)}\n`);
        }
        catch {
            // Hook that does not read stdin is fine.
        }
    });
}
function parseHookStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return {};
    const lines = trimmed.split('\n').filter((line) => line.trim().startsWith('{'));
    for (const line of lines.reverse()) {
        try {
            const parsed = JSON.parse(line);
            const specific = parsed.hookSpecificOutput ?? parsed;
            return {
                decision: typeof parsed.decision === 'string' ? parsed.decision : undefined,
                reason: typeof parsed.reason === 'string'
                    ? parsed.reason
                    : typeof specific.reason === 'string' ? specific.reason : undefined,
                context: typeof specific.additionalContext === 'string'
                    ? specific.additionalContext
                    : typeof parsed.additional_context === 'string' ? parsed.additional_context : undefined,
                message: typeof parsed.systemMessage === 'string' ? parsed.systemMessage : undefined,
            };
        }
        catch {
            // Not JSON: treated as plain context below.
        }
    }
    return { context: trimmed };
}
/**
 * Run every hook registered for an event, in load order (user hooks first).
 * Never throws: all failures become `errors` and, for blocking events, a block.
 */
export async function runHooks(options) {
    const startedAt = Date.now();
    const hooks = hooksForEvent(options.hooks, options.event, options.payload.toolName);
    const outcome = { blocked: false, ran: 0, errors: [], durationMs: 0 };
    if (hooks.length === 0)
        return outcome;
    const spawnFn = options.spawnFn ?? spawn;
    const env = options.env ?? process.env;
    const contexts = [];
    for (const hook of hooks) {
        // Plugin hooks run in-process; no shell spawn. A throwing handler is caught
        // so a plugin can never take the host down.
        if (hook.handler) {
            outcome.ran++;
            try {
                const res = await hook.handler(options.payload);
                if (res) {
                    if (res.blocked) {
                        outcome.blocked = true;
                        outcome.reason = res.reason ?? outcome.reason ?? `blocked by hook: ${hook.source}`;
                    }
                    if (res.context?.trim())
                        contexts.push(res.context.trim());
                    if (res.errors?.length)
                        outcome.errors.push(...res.errors);
                }
            }
            catch (err) {
                const message = `${hook.source}: hook handler threw: ${String(err instanceof Error ? err.message : err)}`;
                outcome.errors.push(message);
                if (BLOCKING_EVENTS.has(options.event)) {
                    outcome.blocked = true;
                    outcome.reason = outcome.reason ?? message;
                    break;
                }
            }
            continue;
        }
        const result = await runOneHook(hook, options.payload, options.cwd, spawnFn, env);
        outcome.ran++;
        if (result.spawnError) {
            const message = `${hook.source}: hook "${hook.command}" could not start (${result.spawnError})`;
            outcome.errors.push(message);
            if (BLOCKING_EVENTS.has(options.event)) {
                outcome.blocked = true;
                outcome.reason = outcome.reason ?? `hook could not run: ${message}`;
                break;
            }
            continue;
        }
        if (result.timedOut) {
            const message = `${hook.source}: hook "${hook.command}" timed out after ${hook.timeoutMs}ms`;
            outcome.errors.push(message);
            if (BLOCKING_EVENTS.has(options.event)) {
                outcome.blocked = true;
                outcome.reason = outcome.reason ?? `hook timed out: ${hook.command}`;
                break;
            }
            continue;
        }
        const parsed = parseHookStdout(result.stdout);
        if (result.code === 2 || parsed.decision === 'block') {
            outcome.blocked = true;
            outcome.reason = outcome.reason
                ?? parsed.reason
                ?? result.stderr.trim()
                ?? `blocked by hook: ${hook.command}`;
            if (!outcome.reason)
                outcome.reason = `blocked by hook: ${hook.command}`;
            logger.info('Hook blocked an action', { event: options.event, hook: hook.command });
            break;
        }
        if (result.code !== 0 && result.code !== null) {
            const message = `${hook.source}: hook "${hook.command}" exited ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 400)}` : ''}`;
            outcome.errors.push(message);
            // 126/127 mean the shell could not execute the hook at all. On a blocking
            // event that must fail closed: a misconfigured guard cannot pass by accident.
            if (BLOCKING_EVENTS.has(options.event) && (result.code === 126 || result.code === 127)) {
                outcome.blocked = true;
                outcome.reason = outcome.reason ?? `hook could not run: ${hook.command}`;
                break;
            }
        }
        const context = parsed.context ?? parsed.message;
        if (context && context.trim())
            contexts.push(context.trim());
    }
    if (contexts.length > 0 && !outcome.blocked)
        outcome.context = contexts.join('\n\n');
    outcome.durationMs = Date.now() - startedAt;
    return outcome;
}
/** Human-readable summary for `--verbose` and `bitacode doctor`. */
export function describeHooks(hooks) {
    if (hooks.length === 0)
        return ['no lifecycle hooks configured'];
    return hooks.map((hook) => `${hook.event}${hook.matcher ? `(${hook.matcher})` : ''}: ${hook.command}`);
}

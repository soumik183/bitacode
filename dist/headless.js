/**
 * headless.ts — non-interactive runs: `bitacode -p "prompt" --json`.
 *
 * CI and scripts cannot use a TUI, but they should not need a different agent
 * either. This mode runs the same loop, the same tools and the same approval
 * layer, with three differences:
 *
 *  - output is JSONL (one object per event) or plain text on stdout;
 *  - approvals never prompt: an unapproved call fails with an actionable error
 *    telling the operator which flag to add;
 *  - the exit code says what happened: 0 success, 1 error, 2 approval blocked,
 *    3 aborted, 4 no configuration.
 *
 * Nothing here re-implements the agent; it only wires the existing pieces
 * together without Ink.
 */
import process from 'node:process';
import fs from 'node:fs/promises';
import { readConfig, detectConfigFromEnvironment } from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createProviderClient } from './providers/client.js';
import { getModelPricing, getRequestDefaultParams } from './providers/index.js';
import { generateSystemPrompt } from './system-prompt.js';
import { runAgenticLoop } from './agentic-loop.js';
import { setToolGroups } from './tools/index.js';
import { loadSettings } from './settings.js';
import { setApprovalHandler, setApprovalMode, setDangerouslySkipPermissions } from './utils/approval.js';
import { setToolFilter } from './tools/index.js';
import { buildLayeredMessages } from './utils/context-layers.js';
import { collectRepoContext, renderRepoContext } from './utils/repo-context.js';
import { memoryFrame } from './utils/memory.js';
import { logger } from './utils/logger.js';
import { createSession, generateTitle, isValidSessionId, saveSession } from './sessions.js';
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_APPROVAL = 2;
export const EXIT_ABORTED = 3;
export const EXIT_NO_CONFIG = 4;
export const EXIT_BUDGET = 5;
/** True when a positive budget cap has been exceeded. */
export function isOverBudget(spentUsd, capUsd) {
    return typeof capUsd === 'number'
        && Number.isFinite(capUsd)
        && capUsd > 0
        && spentUsd > capUsd;
}
/** Write the final assistant message, always ending with a newline. */
export async function writeOutputLastMessage(filePath, text) {
    const body = text.trimEnd();
    await fs.writeFile(filePath, body.length > 0 ? `${body}\n` : '', 'utf8');
}
function resolveConfig(options) {
    const configured = readConfig('active');
    const base = configured ?? detectConfigFromEnvironment();
    if (!base)
        return null;
    return {
        provider: options.provider ?? base.provider,
        model: options.model ?? base.model,
        ...(base.apiKey ? { apiKey: base.apiKey } : {}),
    };
}
/**
 * Run one prompt to completion. Returns the process exit code; never throws for
 * expected failures (missing config, blocked approval, abort).
 */
export async function runHeadless(options) {
    const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
    const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
    const emitJson = (value) => stdout(JSON.stringify(value));
    // Honour the same tool-group setting as the interactive UI.
    setToolGroups(loadSettings().toolGroups);
    if (options.cwd) {
        try {
            process.chdir(options.cwd);
        }
        catch (err) {
            stderr(`bitacode: cannot enter ${options.cwd}: ${String(err instanceof Error ? err.message : err)}`);
            return EXIT_ERROR;
        }
    }
    const prompt = options.prompt?.trim();
    if (!prompt) {
        stderr('bitacode: -p requires a prompt');
        return EXIT_ERROR;
    }
    await loadRuntimeConfig(true).catch(() => undefined);
    const config = resolveConfig(options);
    if (!config) {
        const message = 'No configuration found. Run `bitacode configure` or set an API key environment variable.';
        if (options.json)
            emitJson({ type: 'error', error: message });
        else
            stderr(`bitacode: ${message}`);
        return EXIT_NO_CONFIG;
    }
    let client;
    try {
        client = createProviderClient(config);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json)
            emitJson({ type: 'error', error: message });
        else
            stderr(`bitacode: ${message}`);
        return EXIT_ERROR;
    }
    // Approvals: never prompt. A denial is reported, not waited on.
    const approval = options.approval ?? 'manual';
    setApprovalMode(approval);
    setDangerouslySkipPermissions(approval === 'yolo');
    setToolFilter({ allow: options.allowedTools, deny: options.excludedTools });
    let approvalBlocked = false;
    setApprovalHandler(async (request) => {
        approvalBlocked = true;
        const detail = request.detail ?? request.description;
        const message = `approval required for ${request.type}${detail ? ` (${detail})` : ''}; rerun with --approval auto or --approval yolo`;
        if (options.json)
            emitJson({ type: 'approval_required', kind: request.type, detail: detail ?? null });
        else
            stderr(`bitacode: ${message}`);
        return 'reject';
    });
    const sessionId = options.sessionId ?? `headless-${Date.now().toString(36)}`;
    const systemPrompt = await generateSystemPrompt();
    // Stable prefix first, per-turn frame last (see context-layers.ts).
    const repoContext = await collectRepoContext({ cwd: process.cwd() }).catch(() => null);
    const layers = [
        ...(repoContext ? [{ id: 'repo', stability: 'stable', text: renderRepoContext(repoContext) }] : []),
        { id: 'memory', stability: 'stable', text: memoryFrame() },
    ].filter((layer) => layer.text.trim().length > 0);
    const built = buildLayeredMessages({ system: systemPrompt, layers, history: [] });
    const abortController = new AbortController();
    const onSigint = () => abortController.abort();
    process.on('SIGINT', onSigint);
    let hadError = false;
    let lastAssistantText = '';
    let finalText = '';
    let spentUsd = 0;
    let budgetExceeded = false;
    const onEvent = (event) => {
        switch (event.type) {
            case 'text_delta':
                lastAssistantText += event.content ?? '';
                finalText += event.content ?? '';
                if (options.json)
                    emitJson({ type: 'text', text: event.content ?? '' });
                else if (!options.quiet)
                    process.stdout.write(event.content ?? '');
                break;
            case 'iteration_done':
                if (!options.json && !options.quiet && lastAssistantText)
                    process.stdout.write('\n');
                lastAssistantText = '';
                break;
            case 'tool_call':
                // Text before a tool call is preamble; the final answer comes after the
                // last tool result, so reset the captured final message here.
                finalText = '';
                if (options.json) {
                    emitJson({
                        type: 'tool_call',
                        id: event.toolCall?.id,
                        name: event.toolCall?.name,
                        args: event.toolCall?.args,
                        status: event.toolCall?.status,
                    });
                }
                else if (!options.quiet) {
                    stderr(`[tool] ${event.toolCall?.name} ${event.toolCall?.status ?? ''}`.trim());
                }
                break;
            case 'tool_result':
                if (options.json) {
                    emitJson({
                        type: 'tool_result',
                        id: event.toolCall?.id,
                        name: event.toolCall?.name,
                        status: event.toolCall?.status,
                        result: event.toolCall?.result,
                    });
                }
                break;
            case 'usage':
                spentUsd += Number(event.usage?.cost ?? 0) || 0;
                if (isOverBudget(spentUsd, options.maxBudgetUsd)) {
                    budgetExceeded = true;
                    abortController.abort();
                }
                if (options.json)
                    emitJson({ type: 'usage', usage: event.usage ?? null });
                break;
            case 'error':
                hadError = true;
                if (options.json)
                    emitJson({ type: 'error', error: event.error, transient: Boolean(event.transient) });
                else
                    stderr(`bitacode: ${event.error ?? 'error'}`);
                break;
            case 'done':
                if (options.json)
                    emitJson({ type: 'done' });
                break;
            default:
                if (options.json)
                    emitJson({ type: event.type });
                break;
        }
    };
    const started = Date.now();
    let finalMessages = built.messages;
    try {
        finalMessages = await runAgenticLoop(client, config.model, built.messages, prompt, onEvent, {
            maxIterations: options.maxIterations ?? 100,
            pricing: getModelPricing(config.provider, config.model),
            abortSignal: abortController.signal,
            sessionId,
            requestDefaults: getRequestDefaultParams(config.provider, config.model),
            timeoutMs: options.timeoutMs ?? 0,
        });
    }
    catch (err) {
        hadError = true;
        const message = err instanceof Error ? err.message : String(err);
        if (options.json)
            emitJson({ type: 'error', error: message });
        else
            stderr(`bitacode: ${message}`);
        logger.error('Headless run failed', { error: message });
    }
    finally {
        process.off('SIGINT', onSigint);
    }
    if (options.outputLastMessage) {
        try {
            await writeOutputLastMessage(options.outputLastMessage, finalText || lastAssistantText);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            stderr(`bitacode: could not write ${options.outputLastMessage}: ${message}`);
            hadError = true;
        }
    }
    // A saved headless run must be resumable, so the id has to be a real session
    // id. The runtime tag (`headless-<ts>`) is not one: it used to be written into
    // the session and rejected by the path validator, which is why
    // `-p --save-session` appeared to save nothing.
    let savedSessionId = null;
    if (options.saveSession) {
        try {
            const session = createSession(config.model, config.provider);
            if (options.sessionId && isValidSessionId(options.sessionId))
                session.id = options.sessionId;
            session.completionMessages = finalMessages;
            session.title = generateTitle(finalMessages, 'Headless run');
            await saveSession(session);
            savedSessionId = session.id;
        }
        catch (err) {
            logger.warn('Could not save headless session', { error: String(err) });
        }
    }
    if (!options.json && !options.quiet) {
        if (savedSessionId) {
            stdout(`Session saved: ${savedSessionId}`);
            stdout(`Resume with: bitacode --session ${savedSessionId}`);
        }
        process.stdout.write('\n');
    }
    if (budgetExceeded) {
        const cap = options.maxBudgetUsd ?? 0;
        if (options.json)
            emitJson({ type: 'budget_exceeded', spentUsd, capUsd: cap });
        else
            stderr(`bitacode: budget cap of $${cap.toFixed(2)} reached (spent ~$${spentUsd.toFixed(2)})`);
        return EXIT_BUDGET;
    }
    if (approvalBlocked)
        return EXIT_APPROVAL;
    if (abortController.signal.aborted)
        return EXIT_ABORTED;
    if (hadError)
        return EXIT_ERROR;
    if (options.json) {
        emitJson({ type: 'summary', sessionId: savedSessionId ?? sessionId, durationMs: Date.now() - started });
    }
    return EXIT_OK;
}

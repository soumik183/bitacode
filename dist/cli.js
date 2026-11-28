#!/usr/bin/env node
import { jsx as _jsx } from "react/jsx-runtime";
/**
 * CLI entry point for Bitacode.
 *
 * Parses command-line flags and launches either the main chat UI
 * or the configuration wizard.
 */
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { getTheme, registerCustomTheme } from './theme.js';
import { discoverThemeFiles } from './theme/discovery.js';
import { loadSettings, saveSettings } from './settings.js';
import { logger } from './utils/logger.js';
import { installStableRenderer, installTerminalRestore } from './utils/stable-render.js';
import { checkForUpdate, clearUpdateCache, installUpdate } from './utils/version-check.js';
import { formatInstalled, formatInstallFailure, formatUpdateAvailable, formatUpdateNotice, formatUpdateUnavailable, formatUpToDate, } from './utils/cli-update-format.js';
import { ConfigureComponent, InitComponent, writeConfig, writeInitConfig, detectConfigFromEnvironment } from './config.js';
import { runHeadless } from './headless.js';
import { runPermissionsCommand } from './commands/permissions.js';
import { runPluginsCommand } from './commands/plugins.js';
import { runSessionsCommand } from './commands/sessions.js';
import { collectDoctorReport, renderDoctorReport } from './utils/doctor.js';
import { completionScript, isShellName } from './utils/completion.js';
import { getOutputStyle, listOutputStyles } from './utils/output-styles.js';
import { pruneSpillFiles } from './utils/tool-result-budget.js';
import { createWorktree, listWorktrees, removeWorktree } from './utils/worktree.js';
import { runMcpCommand } from './commands/mcp.js';
import { getAllProviders } from './providers/index.js';
import { getRuntimeConfig, loadRuntimeConfig } from './runtime-config.js';
import { activeAccount, addAccount, exportAccounts, importAccounts, loadAccounts, redactAccount, switchAccount, } from './utils/accounts.js';
import { addSchedule, dueTasks, loadSchedule, parseInterval, removeSchedule } from './utils/schedule.js';
import { createSnapshot, deleteSnapshot, isGitRepo, listSnapshots, restoreSnapshot, } from './utils/vcs-snapshot.js';
// A rejected promise in a background fetch should be logged, not kill the TUI.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
        error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    });
});
// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
// Ink's standard renderer repaints the whole frame but erases every row first,
// which flickers on slow terminals. Rewrite those repaints into a home +
// overwrite so nothing is blanked before it is drawn. Other writes (alt-screen,
// mouse, OSC, logs) pass through untouched.
const program = new Command();
/** Comma-separated CLI list, e.g. `read_file,glob`. */
const commaList = (value) => value.split(',').map((part) => part.trim()).filter(Boolean);
program
    .name('bitacode')
    .description('Bitacode — a simple, hackable coding agent CLI')
    .version(packageJson.version)
    .option('--dangerously-skip-permissions', 'Auto-approve all file writes and shell commands')
    .option('--log-level <level>', 'Log level: TRACE, DEBUG, INFO, WARN, ERROR', 'DEBUG')
    .option('--session <id>', 'Resume a previous session by ID')
    .option('-p, --print <prompt>', 'Run one prompt non-interactively and exit')
    .option('--json', 'With -p: emit one JSON object per event on stdout')
    .option('--approval <mode>', 'Approval mode for -p: manual, auto or yolo')
    .option('--provider <id>', 'Override the configured provider')
    .option('--model <id>', 'Override the configured model')
    .option('--cwd <dir>', 'Run in this directory')
    .option('--max-iterations <n>', 'Cap loop iterations for -p', (value) => Number.parseInt(value, 10))
    .option('--save-session', 'With -p: also save the run as a session')
    .option('--output-last-message <file>', 'With -p: write the final assistant message to a file')
    .option('--allowed-tools <list>', 'With -p: comma-separated tool allowlist', commaList)
    .option('--exclude-tools <list>', 'With -p: comma-separated tool denylist', commaList)
    .option('-q, --quiet', 'With -p: suppress streamed text and tool lines on stderr')
    .option('--timeout-ms <n>', 'With -p: per-request timeout in milliseconds', (value) => Number.parseInt(value, 10))
    .option('--max-budget-usd <n>', 'With -p: abort when estimated spend exceeds this many USD', (value) => Number.parseFloat(value))
    .option('--autoverify', 'Run project checks after a turn that changed files')
    .action(async (options) => {
    // Non-interactive mode: no Ink, no alternate screen, machine-readable exit code.
    if (options.print) {
        const approval = typeof options.approval === 'string' && ['manual', 'acceptEdits', 'auto', 'yolo'].includes(options.approval)
            ? options.approval
            : 'manual';
        const code = await runHeadless({
            prompt: String(options.print),
            json: Boolean(options.json),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.provider ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.session ? { sessionId: options.session } : {}),
            ...(Number.isFinite(options.maxIterations) ? { maxIterations: options.maxIterations } : {}),
            ...(Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {}),
            ...(Number.isFinite(options.maxBudgetUsd) ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
            ...(options.outputLastMessage ? { outputLastMessage: String(options.outputLastMessage) } : {}),
            ...(Array.isArray(options.allowedTools) && options.allowedTools.length > 0 ? { allowedTools: options.allowedTools } : {}),
            ...(Array.isArray(options.excludeTools) && options.excludeTools.length > 0 ? { excludedTools: options.excludeTools } : {}),
            quiet: Boolean(options.quiet),
            approval,
            saveSession: Boolean(options.saveSession),
        });
        process.exitCode = code;
        return;
    }
    // Headless output must never be rewritten by the interactive renderer.
    installStableRenderer(process.stdout);
    if (options.autoverify)
        process.env.BITACODE_AUTOVERIFY = '1';
    // Spill files are a cache, not data: prune old ones in the background.
    void pruneSpillFiles().catch(() => undefined);
    // If the process is killed without a React unmount (Termux, terminal
    // closing, SIGTERM), App's cleanup never runs. Restore at process level.
    installTerminalRestore(process.stdout);
    // Enter the alternate screen and clear BEFORE Ink's first render so the
    // terminal starts from a known state. Hide the cursor while we own it.
    process.stdout.write('\x1b[?1049h');
    // Custom themes must be registered before the first frame, otherwise the
    // terminal canvas and the UI disagree about the background colour.
    const startupSettings = loadSettings();
    if (startupSettings.theme === 'custom' || startupSettings.themePath) {
        try {
            const found = discoverThemeFiles({
                extraDirs: startupSettings.themePath ? [path.dirname(startupSettings.themePath)] : [],
            });
            if (found.ok) {
                for (const file of found.value) {
                    if (registerCustomTheme('custom', file.raw))
                        break;
                }
            }
        }
        catch {
            // A broken theme file must not prevent the app from starting.
        }
    }
    process.stdout.write(`\x1b]11;${getTheme(startupSettings.theme).bg}\x07`);
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
    // Default action - start the main app
    const appProps = {
        dangerouslySkipPermissions: options.dangerouslySkipPermissions || false,
        logLevel: options.logLevel,
        sessionId: options.session,
        version: packageJson.version,
    };
    const instance = render(_jsx(ErrorBoundary, { children: _jsx(App, { ...appProps }) }), { maxFps: 60 });
    // Best-effort notice: render first, then upgrade the UI only if a newer
    // version is cached/available. Never block startup on the network check.
    void checkForUpdate(packageJson.version)
        .then((info) => {
        if (info?.updateAvailable) {
            instance.rerender(_jsx(ErrorBoundary, { children: _jsx(App, { ...appProps, updateNotice: formatUpdateNotice(info.current, info.latest) }) }));
        }
    })
        .catch((error) => logger.debug('Update check failed', { error: String(error) }));
});
// Configure subcommand — no flags. Always global, always automatic.
program
    .command('configure')
    .description('Set up Bitacode globally (provider, model, API key)')
    .action(() => {
    // Step 1: make sure the global config file exists before anything else.
    const created = writeInitConfig('user');
    const configPath = created.path;
    // Step 2: if an API key is already in the environment, fill it in and done.
    const detected = detectConfigFromEnvironment();
    if (detected) {
        writeConfig(detected, 'user');
        console.log('Configured Bitacode (global):');
        console.log(configPath);
        console.log(`${detected.provider} / ${detected.model}`);
        return;
    }
    // Step 3: no key found — let the user pick a provider/model and enter a
    // key. The wizard writes to the global config automatically on completion.
    console.log(`Global config ready: ${configPath}`);
    render(_jsx(ConfigureComponent, {}), { maxFps: 60 });
});
program
    .command('init')
    .description('Create a project-local or shared Bitacode runtime config')
    .option('--project', 'Write <cwd>/.bitacode/bitacode.jsonc')
    .option('--user', 'Write the shared user bitacode.jsonc')
    .option('--force', 'Overwrite an existing target file')
    .action((options) => {
    if (options.project || options.user) {
        if (options.project && options.user) {
            console.error('Choose only one of --project or --user.');
            process.exitCode = 1;
            return;
        }
        const result = writeInitConfig(options.project ? 'project' : 'user', process.cwd(), {
            overwrite: Boolean(options.force),
        });
        const message = result.status === 'created'
            ? 'Created Bitacode config:'
            : result.status === 'overwritten'
                ? 'Overwrote Bitacode config:'
                : 'Bitacode config already exists:';
        console.log(message);
        console.log(result.path);
        return;
    }
    render(_jsx(InitComponent, {}), { maxFps: 60 });
});
// `help` mirrors `--help` for users who type it as a command. Commander's
// implicit help command is disabled here because the root has an action, so
// register one explicitly.
program
    .command('help')
    .description('Display help for bitacode')
    .action(() => {
    program.outputHelp();
});
program
    .command('update')
    .description('Check for and install Bitacode updates')
    .option('--check', 'Only check for an update, do not install')
    .option('--global', 'Install the update globally')
    .option('--local', 'Install the update locally')
    .action(async (options) => {
    try {
        const info = await checkForUpdate(packageJson.version, { force: true });
        if (!info) {
            console.log(formatUpdateUnavailable());
            return;
        }
        if (!info.updateAvailable) {
            clearUpdateCache();
            console.log(formatUpToDate(info.current));
            return;
        }
        if (options.check) {
            console.log(formatUpdateAvailable(info.current, info.latest));
            return;
        }
        const scope = options.local ? 'local' : 'global';
        const result = await installUpdate({
            version: info.latest,
            ...(options.global ? { global: true } : {}),
            ...(options.local ? { global: false } : {}),
        });
        if (!result.success) {
            console.error(formatInstallFailure(info.latest, scope, result.message));
            process.exitCode = 1;
            return;
        }
        clearUpdateCache();
        console.log(formatInstalled(info.current, info.latest, scope));
    }
    catch (error) {
        console.error('Update failed:', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
});
program
    .command('doctor')
    .description('Diagnose configuration, permissions, hooks, storage and terminal support')
    .option('--json', 'Emit the report as JSON')
    .option('--no-checks', 'Skip project check detection')
    .action(async (options) => {
    const report = await collectDoctorReport({
        version: packageJson.version,
        detectProjectChecks: options.checks !== false,
    });
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    }
    else {
        console.log(renderDoctorReport(report));
    }
    process.exitCode = report.ok ? 0 : 1;
});
program
    .command('permissions [args...]')
    .description('Show, trust, untrust or dry-run project permission rules')
    .option('--json', 'Emit JSON')
    .action((args, options) => {
    const parts = args && args.length > 0 ? args : ['show'];
    process.exitCode = runPermissionsCommand(parts, { json: Boolean(options.json) });
});
program
    .command('sessions [args...]')
    .description('List, inspect, replay, fork, rename, pin, archive, prune, delete or export saved sessions')
    .option('--json', 'Emit JSON')
    .option('--out <file>', 'For export: write to this file')
    .action(async (args, options) => {
    // Variadic args so subcommands like `rename <id> <title...>` and
    // `export <id> md --out file.md` reach the command handler intact.
    const parts = [...(args ?? [])];
    if (options.out)
        parts.push('--out', String(options.out));
    if (parts[0] === 'import') {
        try {
            if (!parts[1]) {
                console.error('Usage: bitacode sessions import <path.json>');
                process.exitCode = 1;
                return;
            }
            const { importSessionFile } = await import('./utils/session-import.js');
            const result = importSessionFile(parts[1]);
            if (!result.ok) {
                console.error(result.error);
                process.exitCode = 1;
                return;
            }
            console.log(`Imported session ${result.value.id}`);
            process.exitCode = 0;
        }
        catch (error) {
            console.error(`Session import failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
        return;
    }
    process.exitCode = await runSessionsCommand(parts, { json: Boolean(options.json) });
});
program
    .command('plugins [action] [name]')
    .description('List, enable, disable or inspect plugins')
    .option('--json', 'Emit JSON')
    .action((action, name, options) => {
    process.exitCode = runPluginsCommand([action ?? 'list', ...(name ? [name] : [])].filter(Boolean), { json: Boolean(options.json) });
});
program
    .command('styles [action] [id]')
    .description('List output styles or set one (default, concise, explanatory, learning, proactive, custom)')
    .option('--json', 'Emit JSON')
    .action((action, id, options) => {
    const sub = String(action ?? 'list').toLowerCase();
    if (sub === 'set') {
        if (!id) {
            console.error('Usage: bitacode styles set <id>');
            process.exitCode = 1;
            return;
        }
        const wanted = String(id).trim().toLowerCase();
        const style = getOutputStyle(wanted);
        if (style.id !== wanted) {
            console.error(`Unknown output style: ${id}`);
            console.error(`Available: ${listOutputStyles().map((entry) => entry.id).join(', ')}`);
            process.exitCode = 1;
            return;
        }
        saveSettings({ ...loadSettings(), outputStyle: style.id });
        console.log(`Output style set to ${style.id}`);
        return;
    }
    const styles = listOutputStyles();
    const active = loadSettings().outputStyle ?? 'default';
    if (options.json) {
        console.log(JSON.stringify({ outputStyle: active, styles }));
        return;
    }
    for (const style of styles) {
        const marker = style.id === active ? '*' : ' ';
        console.log(`${marker} ${style.id}  (${style.source})  ${style.description}`);
    }
});
program
    .command('completion <shell>')
    .description('Print a shell completion script (bash, zsh or fish)')
    .action((shell) => {
    if (!isShellName(shell)) {
        console.error(`Unsupported shell: ${shell}. Use bash, zsh or fish.`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write(completionScript(shell));
});
// Git worktree sandboxes — one isolated checkout per task.
program
    .command('worktree <action> [name]')
    .description('Create, list or remove isolated git worktrees (create|list|remove)')
    .option('--base <ref>', 'Base ref for create (default: HEAD)')
    .option('--force', 'Force removal of a worktree with local changes')
    .option('--json', 'Emit JSON')
    .action(async (action, name, options) => {
    const fail = (message) => {
        console.error(message);
        process.exitCode = 1;
    };
    try {
        if (action === 'list') {
            const result = await listWorktrees();
            if (!result.ok)
                return fail(result.error);
            if (options.json) {
                console.log(JSON.stringify(result.value, null, 2));
            }
            else if (result.value.length === 0) {
                console.log('No bitacode worktrees. Create one with: bitacode worktree create <name>');
            }
            else {
                for (const item of result.value)
                    console.log(`${item.name}\t${item.branch}\t${item.path}`);
            }
            return;
        }
        if (!name)
            return fail(`Usage: bitacode worktree ${action} <name>`);
        if (action === 'create') {
            const result = await createWorktree(name, options.base ? { baseRef: options.base } : {});
            if (!result.ok)
                return fail(result.error);
            console.log(options.json ? JSON.stringify(result.value, null, 2) : `Created ${result.value.path} (${result.value.branch})`);
            return;
        }
        if (action === 'remove') {
            const result = await removeWorktree(name, { force: Boolean(options.force) });
            if (!result.ok)
                return fail(result.error);
            console.log(options.json ? JSON.stringify({ removed: name }) : `Removed worktree ${name}`);
            return;
        }
        fail(`Unknown worktree action: ${action}. Use create, list or remove.`);
    }
    catch (error) {
        fail(`Worktree command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
});
// MCP server management without hand-editing JSONC.
program
    .command('mcp [args...]')
    .description('Manage MCP servers (list, add, remove, test, show)')
    .action(async (args) => {
    try {
        process.exitCode = await runMcpCommand(args ?? [], { cwd: process.cwd() });
    }
    catch (error) {
        console.error(`MCP command failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
});
// Opt-in multi-account credentials; the main config is left untouched.
program
    .command('auth [action] [a] [b] [c]')
    .description('Manage accounts: list|add|switch|active|export|import')
    .option('--secrets', 'Include secret values when exporting')
    .option('--file <path>', 'JSON file to import')
    .action((action = 'list', a, b, c, options) => {
    const fail = (message) => {
        console.error(message);
        process.exitCode = 1;
    };
    try {
        switch (action) {
            case 'list': {
                const result = loadAccounts();
                if (!result.ok)
                    return fail(result.error);
                const active = activeAccount();
                const activeId = active.ok ? active.value?.id : undefined;
                for (const account of result.value) {
                    const view = redactAccount(account);
                    console.log(`${account.id}\t${account.provider}\t${view.label}${account.id === activeId ? '\t(active)' : ''}`);
                }
                return;
            }
            case 'add': {
                if (!a || !b || !c)
                    return fail('Usage: bitacode auth add <provider> <label> <apiKey>');
                const result = addAccount({ provider: a, label: b, apiKey: c });
                if (!result.ok)
                    return fail(result.error);
                console.log(`Added account ${result.value.id}`);
                return;
            }
            case 'switch': {
                if (!a)
                    return fail('Usage: bitacode auth switch <id>');
                const result = switchAccount(a);
                if (!result.ok)
                    return fail(result.error);
                console.log(`Active account: ${result.value.id}`);
                return;
            }
            case 'active': {
                const result = activeAccount();
                if (!result.ok)
                    return fail(result.error);
                console.log(result.value ? JSON.stringify(redactAccount(result.value), null, 2) : 'No active account');
                return;
            }
            case 'export': {
                const result = exportAccounts({ includeSecrets: Boolean(options?.secrets) });
                if (!result.ok)
                    return fail(result.error);
                console.log(result.value);
                return;
            }
            case 'import': {
                if (!options?.file)
                    return fail('Usage: bitacode auth import --file <path.json>');
                const text = readFileSync(options.file, 'utf8');
                const result = importAccounts(text);
                if (!result.ok)
                    return fail(result.error);
                console.log(`Imported ${result.value} account(s)`);
                return;
            }
            default:
                fail(`Unknown auth action: ${action}`);
        }
    }
    catch (error) {
        fail(`Auth command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
});
// Local recurring prompts. The store is managed here; running them is opt-in.
program
    .command('schedule [action] [value] [interval]')
    .description('Manage scheduled prompts (list|add|due|rm)')
    .action(async (action = 'list', value, interval) => {
    const fail = (message) => {
        console.error(message);
        process.exitCode = 1;
    };
    try {
        if (action === 'list') {
            const result = await loadSchedule();
            if (!result.ok)
                return fail(result.error);
            for (const task of result.value) {
                console.log(`${task.id}\t${task.enabled ? 'on' : 'off'}\t${new Date(task.nextRunAt).toISOString()}\t${task.prompt}`);
            }
            return;
        }
        if (action === 'due') {
            const result = await dueTasks();
            if (!result.ok)
                return fail(result.error);
            for (const task of result.value)
                console.log(`${task.id}\t${task.prompt}`);
            return;
        }
        if (action === 'add') {
            const ms = interval ? parseInterval(interval) : undefined;
            if (!value || ms === undefined)
                return fail('Usage: bitacode schedule add "<prompt>" <15m|2h|1d>');
            const result = await addSchedule(value, ms);
            if (!result.ok)
                return fail(result.error);
            console.log(`Scheduled ${result.value.id} for ${new Date(result.value.nextRunAt).toISOString()}`);
            return;
        }
        if (action === 'rm') {
            if (!value)
                return fail('Usage: bitacode schedule rm <id>');
            const result = await removeSchedule(value);
            if (!result.ok)
                return fail(result.error);
            console.log(result.value ? `Removed ${value}` : `No schedule named ${value}`);
            return;
        }
        fail(`Unknown schedule action: ${action}`);
    }
    catch (error) {
        fail(`Schedule command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
});
// Git-native snapshots, opt-in through settings.vcsSnapshots.
program
    .command('snapshot [action] [id]')
    .description('Create/list/restore git-native snapshots (opt-in)')
    .option('--apply', 'Actually restore (default is a dry run)')
    .action(async (action = 'list', id, options) => {
    const fail = (message) => {
        console.error(message);
        process.exitCode = 1;
    };
    try {
        if (!loadSettings().vcsSnapshots) {
            return fail('Snapshots are disabled. Enable "vcsSnapshots" in settings.json first.');
        }
        if (!(await isGitRepo()))
            return fail('Not inside a git repository.');
        if (action === 'list') {
            const result = await listSnapshots();
            if (!result.ok)
                return fail(result.error);
            for (const item of result.value)
                console.log(`${item.id}\t${item.createdAt}\t${item.files.join(',')}`);
            return;
        }
        if (action === 'create') {
            const result = await createSnapshot(id ?? 'manual');
            if (!result.ok)
                return fail(result.error);
            console.log(`Snapshot ${result.value.id} (${result.value.ref})`);
            return;
        }
        if (action === 'restore') {
            if (!id) {
                return fail('Usage: bitacode snapshot restore <id> [--apply]');
            }
            const result = await restoreSnapshot(id, { dryRun: options?.apply !== true });
            if (result.ok) {
                console.log(`Restored snapshot ${id}`);
                return;
            }
            // The snapshot module reports a dry run's explanation through `error`
            // by design. Real failures must go to stderr with a non-zero exit.
            if (result.error.startsWith('dry-run:')) {
                console.log(result.error);
                return;
            }
            return fail(result.error);
        }
        if (action === 'delete') {
            if (!id)
                return fail('Usage: bitacode snapshot delete <id>');
            const result = await deleteSnapshot(id);
            if (!result.ok)
                return fail(result.error);
            console.log(`Deleted snapshot ${id}`);
            return;
        }
        fail(`Unknown snapshot action: ${action}`);
    }
    catch (error) {
        fail(`Snapshot command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
});
// Resolved provider/model catalog, including config-only additions.
program
    .command('models [provider]')
    .description('List resolved providers and models')
    .option('--json', 'Emit JSON')
    .action(async (provider, options) => {
    try {
        await loadRuntimeConfig();
        const catalog = getAllProviders()
            .filter((item) => !provider || item.id === provider)
            .map((item) => ({
            id: item.id,
            name: item.name,
            models: item.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow })),
        }));
        if (options.json) {
            console.log(JSON.stringify(catalog, null, 2));
        }
        else {
            const configured = getRuntimeConfig().provider;
            for (const item of catalog) {
                console.log(`${item.id}${item.id === configured ? ' (active)' : ''} — ${item.name}`);
                for (const model of item.models) {
                    console.log(`  ${model.id}\t${model.name}\t${model.contextWindow ?? '?'} ctx`);
                }
            }
        }
    }
    catch (error) {
        console.error(`Could not list models: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
});
program.parse(process.argv);

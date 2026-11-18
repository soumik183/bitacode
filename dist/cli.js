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
import { theme } from './theme.js';
import { logger } from './utils/logger.js';
import { installStableRenderer, installTerminalRestore } from './utils/stable-render.js';
import { ConfigureComponent, InitComponent, readConfig, writeConfig, writeInitConfig } from './config.js';
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
installStableRenderer(process.stdout);
const program = new Command();
program
    .name('bitacode')
    .description('Bitacode — a simple, hackable coding agent CLI')
    .version(packageJson.version)
    .option('--dangerously-skip-permissions', 'Auto-approve all file writes and shell commands')
    .option('--log-level <level>', 'Log level: TRACE, DEBUG, INFO, WARN, ERROR', 'DEBUG')
    .option('--session <id>', 'Resume a previous session by ID')
    .action((options) => {
    // If the process is killed without a React unmount (Termux, terminal
    // closing, SIGTERM), App's cleanup never runs. Restore at process level.
    installTerminalRestore(process.stdout);
    // Enter the alternate screen and clear BEFORE Ink's first render so the
    // terminal starts from a known state. Hide the cursor while we own it.
    process.stdout.write('\x1b[?1049h');
    process.stdout.write(`\x1b]11;${theme.bg}\x07`);
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
    // Default action - start the main app
    render(_jsx(ErrorBoundary, { children: _jsx(App, { dangerouslySkipPermissions: options.dangerouslySkipPermissions || false, logLevel: options.logLevel, sessionId: options.session }) }), { maxFps: 60 });
});
// Configure subcommand
program
    .command('configure')
    .description('Configure AI model and API key settings')
    .option('--project', 'Write <cwd>/.bitacode/bitacode.jsonc')
    .option('--user', 'Write the shared user bitacode.jsonc')
    .option('--provider <id>', 'Provider id to configure')
    .option('--model <id>', 'Model id to configure')
    .option('--api-key <key>', 'Explicit API key to store in bitacode.jsonc')
    .action((options) => {
    if (options.project || options.user || options.provider || options.model || options.apiKey) {
        if (options.project && options.user) {
            console.error('Choose only one of --project or --user.');
            process.exitCode = 1;
            return;
        }
        if (!options.provider || !options.model) {
            console.error('Non-interactive configure requires --provider and --model.');
            process.exitCode = 1;
            return;
        }
        const target = options.project ? 'project' : 'user';
        const resultPath = writeConfig({
            provider: options.provider,
            model: options.model,
            ...(typeof options.apiKey === 'string' && options.apiKey.trim() ? { apiKey: options.apiKey.trim() } : {}),
        }, target);
        console.log('Configured Bitacode:');
        console.log(resultPath);
        const selected = readConfig(target);
        if (selected) {
            console.log(`${selected.provider} / ${selected.model}`);
        }
        return;
    }
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
program.parse(process.argv);

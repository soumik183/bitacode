#!/usr/bin/env node
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
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { getTheme } from './theme.js';
import { loadSettings } from './settings.js';
import { logger } from './utils/logger.js';
import { installStableRenderer, installTerminalRestore } from './utils/stable-render.js';
import { checkForUpdate, installUpdate } from './utils/version-check.js';
import {
  formatInstalled,
  formatUpdateAvailable,
  formatUpdateNotice,
  formatUpdateUnavailable,
  formatUpToDate,
} from './utils/cli-update-format.js';
import { ConfigureComponent, InitComponent, writeConfig, writeInitConfig, detectConfigFromEnvironment } from './config.js';
import { runHeadless, type HeadlessApproval } from './headless.js';
import { runPermissionsCommand } from './commands/permissions.js';
import { runPluginsCommand } from './commands/plugins.js';
import { runSessionsCommand } from './commands/sessions.js';
import { collectDoctorReport, renderDoctorReport } from './utils/doctor.js';
import { completionScript, isShellName } from './utils/completion.js';
import { pruneSpillFiles } from './utils/tool-result-budget.js';

// A rejected promise in a background fetch should be logged, not kill the TUI.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson: { version: string } = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

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
  .option('-p, --print <prompt>', 'Run one prompt non-interactively and exit')
  .option('--json', 'With -p: emit one JSON object per event on stdout')
  .option('--approval <mode>', 'Approval mode for -p: manual, auto or yolo')
  .option('--provider <id>', 'Override the configured provider')
  .option('--model <id>', 'Override the configured model')
  .option('--cwd <dir>', 'Run in this directory')
  .option('--max-iterations <n>', 'Cap loop iterations for -p', (value: string) => Number.parseInt(value, 10))
  .option('--save-session', 'With -p: also save the run as a session')
  .option('--autoverify', 'Run project checks after a turn that changed files')
  .action(async (options) => {
    // Non-interactive mode: no Ink, no alternate screen, machine-readable exit code.
    if (options.print) {
      const approval = typeof options.approval === 'string' && ['manual', 'auto', 'yolo'].includes(options.approval)
        ? (options.approval as HeadlessApproval)
        : 'manual';
      const code = await runHeadless({
        prompt: String(options.print),
        json: Boolean(options.json),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.session ? { sessionId: options.session } : {}),
        ...(Number.isFinite(options.maxIterations) ? { maxIterations: options.maxIterations as number } : {}),
        approval,
        saveSession: Boolean(options.saveSession),
      });
      process.exitCode = code;
      return;
    }

    if (options.autoverify) process.env.BITACODE_AUTOVERIFY = '1';
    // Spill files are a cache, not data: prune old ones in the background.
    void pruneSpillFiles().catch(() => undefined);

    // If the process is killed without a React unmount (Termux, terminal
    // closing, SIGTERM), App's cleanup never runs. Restore at process level.
    installTerminalRestore(process.stdout);
    // Enter the alternate screen and clear BEFORE Ink's first render so the
    // terminal starts from a known state. Hide the cursor while we own it.
    process.stdout.write('\x1b[?1049h');
    // App applies the saved palette after mount; the terminal canvas must use
    // that same colour from the first frame, not the hard-coded dark default.
    process.stdout.write(`\x1b]11;${getTheme(loadSettings().theme).bg}\x07`);
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');

    // Default action - start the main app
    const appProps = {
      dangerouslySkipPermissions: options.dangerouslySkipPermissions || false,
      logLevel: options.logLevel,
      sessionId: options.session,
      version: packageJson.version,
    };
    const instance = render(
      <ErrorBoundary>
        <App {...appProps} />
      </ErrorBoundary>,
      { maxFps: 60 }
    );

    // Best-effort notice: render first, then upgrade the UI only if a newer
    // version is cached/available. Never block startup on the network check.
    void checkForUpdate(packageJson.version)
      .then((info) => {
        if (info?.updateAvailable) {
          instance.rerender(
            <ErrorBoundary>
              <App {...appProps} updateNotice={formatUpdateNotice(info.latest)} />
            </ErrorBoundary>
          );
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
    render(<ConfigureComponent />, { maxFps: 60 });
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

    render(<InitComponent />, { maxFps: 60 });
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
        console.log(formatUpToDate(info.current));
        return;
      }
      if (options.check) {
        console.log(formatUpdateAvailable(info.current, info.latest));
        return;
      }

      const result = await installUpdate({
        version: info.latest,
        ...(options.global ? { global: true } : {}),
        ...(options.local ? { global: false } : {}),
      });
      console.log(result.message);
      if (result.success) {
        console.log(formatInstalled(info.latest));
      }
    } catch (error) {
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
    } else {
      console.log(renderDoctorReport(report));
    }
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command('permissions [action] [target]')
  .description('Show, trust or untrust project permission rules')
  .option('--json', 'Emit JSON')
  .action((action, target, options) => {
    process.exitCode = runPermissionsCommand(
      [action ?? 'show', ...(target ? [target] : [])].filter(Boolean) as string[],
      { json: Boolean(options.json) },
    );
  });

program
  .command('sessions [args...]')
  .description('List, inspect, replay, fork, rename, pin or export saved sessions')
  .option('--json', 'Emit JSON')
  .option('--out <file>', 'For export: write to this file')
  .action(async (args: string[], options) => {
    // Variadic args so subcommands like `rename <id> <title...>` and
    // `export <id> md --out file.md` reach the command handler intact.
    const parts = [...(args ?? [])];
    if (options.out) parts.push('--out', String(options.out));
    process.exitCode = await runSessionsCommand(parts, { json: Boolean(options.json) });
  });

program
  .command('plugins [action] [name]')
  .description('List, enable, disable or inspect plugins')
  .option('--json', 'Emit JSON')
  .action((action, name, options) => {
    process.exitCode = runPluginsCommand(
      [action ?? 'list', ...(name ? [name] : [])].filter(Boolean) as string[],
      { json: Boolean(options.json) },
    );
  });

program
  .command('completion <shell>')
  .description('Print a shell completion script (bash, zsh or fish)')
  .action((shell: string) => {
    if (!isShellName(shell)) {
      console.error(`Unsupported shell: ${shell}. Use bash, zsh or fish.`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(completionScript(shell));
  });

program.parse(process.argv);

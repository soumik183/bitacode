/** watch tool — watch a file or directory for changes for a bounded time. */

import fs from 'node:fs';
import { startProcess } from './process.js';
import { cap, errorMessage, requestApprovalOrMessage } from './system-helpers.js';

const MAX_WATCH_EVENTS = 200;
const MAX_WATCH_COMMANDS = 10;

export const watchTool = {
  type: 'function' as const,
  function: {
    name: 'watch',
    description:
      'Watch a file or directory for changes for a bounded time. Optionally run a safe command on each change ' +
      '(requires approval). Always returns after the duration, even with no events.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to watch.' },
        duration_ms: { type: 'number', description: 'How long to watch in milliseconds (default 5000, max 60000).' },
        command: { type: 'string', description: 'Optional safe command to run when a change is detected.' },
      },
      required: ['path'],
    },
  },
};

// Mirrors bash/process safe-command gating so watch cannot run arbitrary shells.
const WATCH_CONTROL_PATTERN = /[;&|<>()`$[\]{}!]/;
const WATCH_SAFE_COMMANDS = [
  'pwd', 'whoami', 'date', 'uname', 'uptime',
  'git status', 'git log', 'git diff', 'git branch',
  'node --version', 'npm --version', 'ls', 'cat', 'echo', 'sleep',
];

function isWatchSafe(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || WATCH_CONTROL_PATTERN.test(trimmed) || /[\r\n]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (/(^|[;&|]\s*)(sudo|su)\b/.test(lower)) return false;
  return WATCH_SAFE_COMMANDS.some((safe) => trimmed === safe || trimmed.startsWith(`${safe} `));
}

export async function watch(
  targetPath: string,
  durationMs = 5000,
  command?: string,
  sessionId?: string,
): Promise<string> {
  try {
    if (typeof targetPath !== 'string' || targetPath.trim() === '') return 'Error: path is required.';
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
      return 'Error: duration_ms must be a number.';
    }
    const duration = Math.min(Math.max(Math.floor(durationMs), 100), 60_000);
    if (command !== undefined && typeof command !== 'string') return 'Error: command must be a string.';
    if (command !== undefined && !isWatchSafe(command)) {
      return `Error: watch command '${command}' is not a safe command.`;
    }
    if (command) {
      const denial = await requestApprovalOrMessage({
        id: `watch-${Date.now()}`,
        type: 'shell_command',
        description: `Run command on file change: ${command}`,
        detail: `Watching: ${targetPath}\nCommand: ${command}`,
        sessionId,
        sessionScopeKey: `shell:watch:${command}`,
      }, `Command cancelled by user: ${command}`);
      if (denial !== null) return denial;
    }

    const events: Array<{ type: string; path: string; at: number }> = [];
    let watcher: fs.FSWatcher | undefined;
    let runs = 0;
    let lastRun = 0;

    return await new Promise<string>((resolve) => {
      let settled = false;
      const finish = (text: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { watcher?.close(); } catch { /* already closed */ }
        resolve(text);
      };

      const timer = setTimeout(() => {
        const lines = events.map((event) => `${event.type} ${event.path} @${event.at}`);
        const summary = `Watched '${targetPath}' for ${duration}ms. ${events.length} event(s).`;
        const body = lines.length ? lines.join('\n') : 'No changes detected.';
        const note = runs > 0 ? `\nRan command ${runs} time(s).` : '';
        finish(cap(`${summary}\n${body}${note}`));
      }, duration);

      try {
        watcher = fs.watch(targetPath, (eventType, filename) => {
          if (events.length < MAX_WATCH_EVENTS) {
            events.push({ type: eventType, path: filename ? String(filename) : '(self)', at: Date.now() });
          }
          // fs.watch often emits a burst per write — debounce and cap the runs.
          if (command && Date.now() - lastRun >= 200 && runs < MAX_WATCH_COMMANDS) {
            lastRun = Date.now();
            runs += 1;
            void startProcess(command, sessionId);
          }
        });
        watcher.on('error', (err) => finish(`Error watching '${targetPath}': ${errorMessage(err)}`));
      } catch (err) {
        finish(`Error: ${errorMessage(err)}`);
      }
    });
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

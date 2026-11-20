/**
 * Logger utility with configurable log levels.
 *
 * Levels (from least to most verbose):
 *   ERROR (0) → WARN (1) → INFO (2) → DEBUG (3) → TRACE (4)
 *
 * Set the level via `setLogLevel()` or the `--log-level` CLI flag.
 * Logs are written to a file to avoid interfering with Ink UI rendering.
 */

import { mkdirSync, existsSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import stripAnsi from 'strip-ansi';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

let currentLevel: LogLevel = LogLevel.INFO;
let logFilePath: string | null = null;
// One kept-open stream instead of an append-and-open per line: debug logging on
// every tool delta used to mean thousands of synchronous open/write/close calls.
let logStream: WriteStream | null = null;

// In-memory log buffer for UI display
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

const logBuffer: LogEntry[] = [];
let logListeners: Array<(entry: LogEntry) => void> = [];

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  logListeners.push(listener);
  // Return unsubscribe function
  return () => {
    logListeners = logListeners.filter(l => l !== listener);
  };
}

export function getRecentLogs(count: number = 50): LogEntry[] {
  return logBuffer.slice(-count);
}

export function initLogFile(): string {
  // Create logs directory private to the user: logs contain prompts and paths.
  const logsDir = getLogDirectory();
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  }

  // Create log file with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  logFilePath = join(logsDir, `bitacode-${timestamp}.log`);
  closeLogFile();

  // Write header
  writeToFile(`\n${'='.repeat(80)}\nBitacode Log - ${new Date().toISOString()}\n${'='.repeat(80)}\n`);

  return logFilePath;
}

/** Directory that holds the log files (created on first write). */
export function getLogDirectory(): string {
  return join(homedir(), '.local', 'share', 'bitacode', 'logs');
}

/** Path of the current log file, or the directory when logging is not enabled. */
export function getLogFilePath(): string {
  return logFilePath ?? getLogDirectory();
}

/** Flush and close the log stream (tests and process exit). */
export function closeLogFile(): void {
  if (!logStream) return;
  try {
    logStream.end();
  } catch {
    // Already closed.
  }
  logStream = null;
}

function writeToFile(message: string): void {
  if (!logFilePath) {
    initLogFile();
  }
  try {
    if (!logStream) {
      logStream = createWriteStream(logFilePath!, { flags: 'a', mode: 0o600 });
      // A failed log write must never take the TUI down.
      logStream.on('error', () => {
        logStream = null;
      });
    }
    logStream.write(message);
  } catch (err) {
    // Emit to stderr since we can't write to log file
    process.stderr.write(`Failed to write to log file: ${err}\n`);
  }
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[Object with circular references]';
  }
}

function log(level: LogLevel, label: string, message: string, context?: Record<string, unknown>): void {
  if (level > currentLevel) return;
  const ts = timestamp();

  // Create log entry
  const entry: LogEntry = {
    timestamp: ts,
    level,
    message,
    context,
  };

  // Add to buffer (keep last 100 entries)
  logBuffer.push(entry);
  if (logBuffer.length > 100) {
    logBuffer.shift();
  }

  // Notify listeners
  logListeners.forEach(listener => listener(entry));

  // Write to file
  const ctx = context ? ` ${safeStringify(context)}` : '';
  // Security: Strip ANSI escape codes to prevent terminal injection attacks
  const sanitizedMessage = stripAnsi(message);
  const sanitizedCtx = stripAnsi(ctx);
  writeToFile(`[${ts}] ${label.padEnd(5)} ${sanitizedMessage}${sanitizedCtx}\n`);
}

export const logger = {
  error: (msg: string, ctx?: Record<string, unknown>) => log(LogLevel.ERROR, 'ERROR', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log(LogLevel.WARN, 'WARN', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log(LogLevel.INFO, 'INFO', msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log(LogLevel.DEBUG, 'DEBUG', msg, ctx),
  trace: (msg: string, ctx?: Record<string, unknown>) => log(LogLevel.TRACE, 'TRACE', msg, ctx),

  /** Start a timed operation. Call the returned `end()` to log the duration. */
  startOperation(name: string): { end: () => void } {
    const start = performance.now();
    logger.debug(`${name} started`);
    return {
      end() {
        const ms = (performance.now() - start).toFixed(1);
        logger.debug(`${name} completed`, { durationMs: ms });
      },
    };
  },

  /** Get the path to the current log file */
  getLogFilePath(): string | null {
    return logFilePath;
  },
};

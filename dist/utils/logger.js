/**
 * Logger utility with configurable log levels.
 *
 * Levels (from least to most verbose):
 *   ERROR (0) → WARN (1) → INFO (2) → DEBUG (3) → TRACE (4)
 *
 * Set the level via `setLogLevel()` or the `--log-level` CLI flag.
 * Logs are written to a file to avoid interfering with Ink UI rendering.
 */
import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import stripAnsi from 'strip-ansi';
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["ERROR"] = 0] = "ERROR";
    LogLevel[LogLevel["WARN"] = 1] = "WARN";
    LogLevel[LogLevel["INFO"] = 2] = "INFO";
    LogLevel[LogLevel["DEBUG"] = 3] = "DEBUG";
    LogLevel[LogLevel["TRACE"] = 4] = "TRACE";
})(LogLevel || (LogLevel = {}));
let currentLevel = LogLevel.INFO;
let logFilePath = null;
// One kept-open stream instead of an append-and-open per line: debug logging on
// every tool delta used to mean thousands of synchronous open/write/close calls.
let logStream = null;
const logBuffer = [];
let logListeners = [];
export function setLogLevel(level) {
    currentLevel = level;
}
export function getLogLevel() {
    return currentLevel;
}
export function onLog(listener) {
    logListeners.push(listener);
    // Return unsubscribe function
    return () => {
        logListeners = logListeners.filter(l => l !== listener);
    };
}
export function getRecentLogs(count = 50) {
    return logBuffer.slice(-count);
}
export function initLogFile() {
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
export function getLogDirectory() {
    return join(homedir(), '.local', 'share', 'bitacode', 'logs');
}
/** Path of the current log file, or the directory when logging is not enabled. */
export function getLogFilePath() {
    return logFilePath ?? getLogDirectory();
}
/** Flush and close the log stream (tests and process exit). */
export function closeLogFile() {
    if (!logStream)
        return;
    try {
        logStream.end();
    }
    catch {
        // Already closed.
    }
    logStream = null;
}
function writeToFile(message) {
    if (!logFilePath) {
        initLogFile();
    }
    try {
        if (!logStream) {
            logStream = createWriteStream(logFilePath, { flags: 'a', mode: 0o600 });
            // A failed log write must never take the TUI down.
            logStream.on('error', () => {
                logStream = null;
            });
        }
        logStream.write(message);
    }
    catch (err) {
        // Emit to stderr since we can't write to log file
        process.stderr.write(`Failed to write to log file: ${err}\n`);
    }
}
function timestamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    }
    catch {
        return '[Object with circular references]';
    }
}
function log(level, label, message, context) {
    if (level > currentLevel)
        return;
    const ts = timestamp();
    // Create log entry
    const entry = {
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
    error: (msg, ctx) => log(LogLevel.ERROR, 'ERROR', msg, ctx),
    warn: (msg, ctx) => log(LogLevel.WARN, 'WARN', msg, ctx),
    info: (msg, ctx) => log(LogLevel.INFO, 'INFO', msg, ctx),
    debug: (msg, ctx) => log(LogLevel.DEBUG, 'DEBUG', msg, ctx),
    trace: (msg, ctx) => log(LogLevel.TRACE, 'TRACE', msg, ctx),
    /** Start a timed operation. Call the returned `end()` to log the duration. */
    startOperation(name) {
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
    getLogFilePath() {
        return logFilePath;
    },
};

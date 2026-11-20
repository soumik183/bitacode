/**
 * project-trust.ts — remembers which directories the user has vouched for.
 *
 * Project-local configuration (permission rules, lifecycle hooks, custom slash
 * commands) is code. Opening a freshly cloned repository must therefore not be
 * enough to run it: the directory has to be trusted first, either with
 * `bitacode permissions trust` or by answering the prompt once.
 *
 * The store lives outside the project (`~/.local/share/bitacode/trusted.json`)
 * so cloning a repo never carries trust with it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

interface TrustFile {
  version: 1;
  /** Real paths, so a symlinked checkout trusts once. */
  directories: string[];
}

const FILE_VERSION = 1;

function dataDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode');
}

function storePath(): string {
  return path.join(dataDir(), 'trusted.json');
}

/** Resolve symlinks when possible; fall back to the absolute path. */
export function canonicalProjectPath(directory: string): string {
  const absolute = path.resolve(directory || process.cwd());
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function readStore(): TrustFile {
  const file = storePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TrustFile>;
    const directories = Array.isArray(parsed.directories)
      ? parsed.directories.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
    return { version: FILE_VERSION, directories };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') logger.warn('Could not read trusted-project store', { file, error: String(err) });
    return { version: FILE_VERSION, directories: [] };
  }
}

function writeStore(store: TrustFile): void {
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('Could not write trusted-project store', { file, error: String(err) });
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

export function isProjectTrusted(directory: string): boolean {
  const canonical = canonicalProjectPath(directory);
  return readStore().directories.includes(canonical);
}

/** Trust a directory (idempotent). Returns the canonical path that is trusted. */
export function trustProject(directory: string): string {
  const canonical = canonicalProjectPath(directory);
  const store = readStore();
  if (!store.directories.includes(canonical)) {
    store.directories.push(canonical);
    writeStore(store);
    logger.info('Trusted project directory', { directory: canonical });
  }
  return canonical;
}

/** Remove trust for a directory. Returns true when something was removed. */
export function untrustProject(directory: string): boolean {
  const canonical = canonicalProjectPath(directory);
  const store = readStore();
  const next = store.directories.filter((entry) => entry !== canonical);
  if (next.length === store.directories.length) return false;
  writeStore({ version: FILE_VERSION, directories: next });
  logger.info('Removed project trust', { directory: canonical });
  return true;
}

export function listTrustedProjects(): string[] {
  return readStore().directories;
}

/** Where the trust file lives, for `bitacode doctor`. */
export function trustStorePath(): string {
  return storePath();
}

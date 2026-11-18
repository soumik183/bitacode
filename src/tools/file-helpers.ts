/**
 * Shared helpers for the file-operation tools.
 *
 * Single boundary for error handling, output capping, path validation and
 * approval so tool files stay thin and no helper logic is duplicated.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { requestApproval, type ApprovalRequest } from '../utils/approval.js';
import {
  getAllowedPathRoots,
  getWorkingDirectory,
  validatePath,
} from '../utils/path-validation.js';

const MAX_OUTPUT_CHARS = 20_000;

export { computeUnifiedDiff } from '../utils/unified-diff.js';

// ─── Output capping & errors ───

export function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code);
  }
  return undefined;
}

/** Single boundary for every handler: errors become strings, never throws. */
export async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return capOutput(await fn());
  } catch (err) {
    return capOutput(`Error: ${errorMessage(err)}`);
  }
}

// ─── Argument validation ───

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

// ─── Path validation wrapper ───

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function protectedRoots(): string[] {
  return Array.from(new Set([getWorkingDirectory(), process.cwd(), ...getAllowedPathRoots()]));
}

export function assertNotProtected(validated: string, action: string): void {
  if (protectedRoots().includes(validated)) {
    throw new Error(`Refusing to ${action}: it is the project root or a configured allowed root.`);
  }
}

// ─── Approval ───

export async function approve(
  type: ApprovalRequest['type'],
  description: string,
  detail: string,
  scope: string,
  sessionId?: string,
): Promise<boolean> {
  return requestApproval({
    id: `file-ops-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    description,
    detail,
    sessionId,
    sessionScopeKey: `${type}:${scope}`,
  });
}

export function cancelled(operation: string): string {
  return `Operation cancelled: ${operation} was rejected by user. No files were changed.`;
}

// ─── File helpers ───

export async function readRegularFile(target: string, label: string, maxBytes: number): Promise<{ content: string; mode: number }> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') throw new Error(`'${label}': file not found.`);
    throw new Error(`'${label}': cannot access file: ${errorMessage(err)}`);
  }
  if (!stat.isFile()) throw new Error(`'${label}' is not a regular file.`);
  if (stat.size > maxBytes) {
    throw new Error(`'${label}' is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit ${maxBytes / 1024 / 1024} MB).`);
  }
  return { content: await fs.readFile(target, 'utf8'), mode: stat.mode & 0o777 };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Shared rename/move implementation ───

export async function relocate(
  verb: 'rename' | 'move',
  source: unknown,
  destination: unknown,
  overwrite: unknown,
  createParents: boolean,
  sessionId?: string,
): Promise<string> {
  return safe(async () => {
    const src = requireString(source, 'source');
    const dst = requireString(destination, 'destination');
    const srcValidated = await validatePath(src);
    const dstValidated = await validatePath(dst);
    if (srcValidated === dstValidated) throw new Error('source and destination are the same path.');
    assertNotProtected(srcValidated, `${verb} '${src}'`);
    assertNotProtected(dstValidated, `${verb} to '${dst}'`);

    if (!(await pathExists(srcValidated))) throw new Error(`'${src}': source not found.`);
    const canOverwrite = asBoolean(overwrite);
    const destExists = await pathExists(dstValidated);
    if (destExists && !canOverwrite) {
      throw new Error(`destination already exists: ${dst}. Pass overwrite: true to replace it.`);
    }
    if (createParents) await fs.mkdir(path.dirname(dstValidated), { recursive: true });

    const approved = await approve(
      'file_edit',
      `${verb === 'move' ? 'Move' : 'Rename'} ${src} to ${dst}`,
      `From: ${srcValidated}\nTo: ${dstValidated}\nOverwrite: ${canOverwrite}`,
      `${verb}:${srcValidated}:${dstValidated}`,
      sessionId,
    );
    if (!approved) return cancelled(`${verb} of ${src}`);

    try {
      await fs.rename(srcValidated, dstValidated);
    } catch (err) {
      if (!destExists || !canOverwrite) throw err;
      // Only remove the destination once the caller explicitly allowed it.
      await fs.rm(dstValidated, { recursive: true, force: true });
      await fs.rename(srcValidated, dstValidated);
    }
    return `${verb === 'move' ? 'Moved' : 'Renamed'} ${src} to ${dst}.`;
  });
}

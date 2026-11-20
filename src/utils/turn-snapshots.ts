/**
 * turn-snapshots.ts — per-turn manifests so a conversation can be rewound.
 *
 * `/undo` already restores files, but it restores *files* without touching the
 * conversation, which leaves the model talking about edits that no longer exist.
 * A turn manifest records the checkpoint ids created during one user turn plus the
 * message index it started at, so `/rewind 3` can put both the workspace and the
 * transcript back to the same point.
 *
 * Storage is one JSON file per session under the data dir, rewritten atomically.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

export interface CheckpointRef {
  tool: string;
  /** Checkpoint ids returned by createCheckpoint, in execution order. */
  ids: string[];
  paths: string[];
}

export interface TurnManifest {
  turn: number;
  startedAt: string;
  endedAt?: string;
  /** Index into the message array where this turn began (the user message). */
  messageIndex: number;
  firstUserText: string;
  checkpoints: CheckpointRef[];
  /** Files touched during the turn, for display. */
  paths: string[];
}

export interface SessionTurns {
  version: 1;
  sessionId: string;
  turns: TurnManifest[];
}

function dataDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bitacode', 'turns');
}

export function turnsFilePath(sessionId: string): string {
  const safe = (sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dataDir(), `${safe}.json`);
}

export function loadSessionTurns(sessionId: string): SessionTurns {
  const empty: SessionTurns = { version: 1, sessionId, turns: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(turnsFilePath(sessionId), 'utf8')) as Partial<SessionTurns>;
    if (!parsed || !Array.isArray(parsed.turns)) return empty;
    return {
      version: 1,
      sessionId,
      turns: parsed.turns.filter((turn): turn is TurnManifest =>
        Boolean(turn) && typeof turn.turn === 'number' && typeof turn.messageIndex === 'number'),
    };
  } catch {
    return empty;
  }
}

function saveSessionTurns(record: SessionTurns): void {
  const file = turnsFilePath(record.sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn('Could not save turn manifests', { file, error: String(err) });
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Begin a turn. Returns the manifest that `endTurn` will complete. */
export function beginTurn(sessionId: string, messageIndex: number, firstUserText: string): TurnManifest {
  const record = loadSessionTurns(sessionId);
  const turn = (record.turns[record.turns.length - 1]?.turn ?? 0) + 1;
  const manifest: TurnManifest = {
    turn,
    startedAt: new Date().toISOString(),
    messageIndex,
    firstUserText: firstUserText.replace(/\s+/g, ' ').trim().slice(0, 160),
    checkpoints: [],
    paths: [],
  };
  record.turns.push(manifest);
  saveSessionTurns(record);
  return manifest;
}

/** Attach a checkpoint to the current turn. */
export function recordTurnCheckpoint(
  sessionId: string,
  entry: { tool: string; ids: string[]; paths: string[] },
): void {
  const record = loadSessionTurns(sessionId);
  const current = record.turns[record.turns.length - 1];
  if (!current) return;
  current.checkpoints.push(entry);
  for (const target of entry.paths) {
    if (!current.paths.includes(target)) current.paths.push(target);
  }
  saveSessionTurns(record);
}

/** Close the current turn. */
export function endTurn(sessionId: string): TurnManifest | null {
  const record = loadSessionTurns(sessionId);
  const current = record.turns[record.turns.length - 1];
  if (!current) return null;
  current.endedAt = new Date().toISOString();
  saveSessionTurns(record);
  return current;
}

/**
 * Resolve `rewind <n>` semantics: n = 0 is the last turn, 1 the one before it.
 * Returns the manifest and the message index to truncate to.
 */
export function resolveRewind(sessionId: string, turnsBack: number): TurnManifest | null {
  const { turns } = loadSessionTurns(sessionId);
  if (turns.length === 0) return null;
  const index = turns.length - 1 - Math.max(0, Math.trunc(turnsBack));
  return turns[index] ?? null;
}

/** Checkpoint ids that a rewind to `manifest` must restore, newest first. */
export function checkpointsForRewind(manifest: TurnManifest): string[] {
  const ids: string[] = [];
  for (const entry of manifest.checkpoints) {
    for (const id of entry.ids) ids.push(id);
  }
  return ids.reverse();
}

/** Drop manifests at or after the rewound turn. */
export function truncateTurns(sessionId: string, keepThroughTurn: number): void {
  const record = loadSessionTurns(sessionId);
  record.turns = record.turns.filter((turn) => turn.turn <= keepThroughTurn);
  saveSessionTurns(record);
}

export function describeTurn(manifest: TurnManifest): string {
  const files = manifest.paths.length > 0 ? ` · ${manifest.paths.length} file(s)` : '';
  return `#${manifest.turn} ${manifest.firstUserText || '(empty prompt)'}${files}`;
}

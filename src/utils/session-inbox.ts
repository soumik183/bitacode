/**
 * session-inbox.ts — in-memory prompt admission for a turn that is already running.
 *
 * OpenCode v2 lets a user interrupt a live turn in two ways: `steer` (the next
 * model step should see this instead of whatever was queued) and `queue` (take
 * effect after the running turn finishes). This module is the dependency-free
 * admission layer for both: it owns deduplication, per-session ordering, the
 * compaction/rewind boundary, and the hard limits that keep a long-lived CLI
 * process from accumulating unbounded prompt text.
 *
 * Everything is synchronous and every public method returns immediately, so a
 * batch of concurrent calls cannot interleave across an `await` and lose an
 * update. Entries are cloned on the way in and on the way out; callers never
 * hold a reference to internal state. Admitted entries are retained (marked as
 * no longer pending) so a retried delivery returns the *original* item rather
 * than admitting a second copy — "first admission wins".
 */

export type DeliveryMode = 'steer' | 'queue';

export interface IncomingPrompt {
  id: string;
  sessionId: string;
  text: string;
  mode: DeliveryMode;
  enqueuedAt: number;
  /** optional control items (compaction/rewind) form delivery boundaries */
  control?: boolean;
}

export type InboxResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PromptInbox {
  /** Admit a prompt. Idempotent by (id, sessionId); never throws. */
  enqueue(item: IncomingPrompt): InboxResult<IncomingPrompt>;
  /** Take the next deliverable prompt out of a session's pending set. */
  deliverNext(sessionId: string, options?: { allowSteer?: boolean }): InboxResult<IncomingPrompt>;
  /** Pending prompts in enqueue order (defensive copies). */
  pending(sessionId: string): IncomingPrompt[];
  /** Acknowledge/remove a pending prompt; false if it is unknown or delivered. */
  ack(sessionId: string, id: string): boolean;
  /** Drop every entry (pending and admitted history) for a session. */
  clear(sessionId: string): void;
  /** Number of pending prompts across all sessions. */
  size(): number;
}

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const MAX_ID_CHARS = 128;

interface Entry {
  item: IncomingPrompt;
  pending: boolean;
}

function ok<T>(value: T): InboxResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): InboxResult<T> {
  return { ok: false, error };
}

/** All fields are primitives, so a field-by-field copy is a full copy. */
function copyItem(item: IncomingPrompt): IncomingPrompt {
  const copy: IncomingPrompt = {
    id: item.id,
    sessionId: item.sessionId,
    text: item.text,
    mode: item.mode,
    enqueuedAt: item.enqueuedAt,
  };
  if (item.control !== undefined) copy.control = item.control;
  return copy;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function createInbox(options?: { maxItems?: number; maxTextChars?: number }): PromptInbox {
  let maxItems = DEFAULT_MAX_ITEMS;
  let maxTextChars = DEFAULT_MAX_TEXT_CHARS;
  try {
    maxItems = safeLimit(options?.maxItems, DEFAULT_MAX_ITEMS);
    maxTextChars = safeLimit(options?.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  } catch {
    // Broken options object: keep the documented defaults.
  }

  // Map iteration order is insertion order, which is the enqueue order. An
  // entry stays here after delivery so a retry with the same id is idempotent.
  const entries = new Map<string, Entry>();

  function pendingCount(): number {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.pending) count++;
    }
    return count;
  }

  function pendingFor(sessionId: string): Entry[] {
    const result: Entry[] = [];
    for (const entry of entries.values()) {
      if (entry.pending && entry.item.sessionId === sessionId) result.push(entry);
    }
    return result;
  }

  return {
    enqueue(item) {
      try {
        if (!item || typeof item !== 'object') {
          return fail('Invalid prompt: expected a prompt object.');
        }
        // Read every field up front: a hostile getter cannot leave a half-built
        // entry behind because nothing is stored until validation succeeds.
        const { id, sessionId, text, mode, enqueuedAt, control } = item;
        if (!isNonEmptyString(id)) return fail('Invalid prompt: id must be a non-empty string.');
        if (id.length > MAX_ID_CHARS) {
          return fail(`Invalid prompt: id must be at most ${MAX_ID_CHARS} characters.`);
        }
        if (!isNonEmptyString(sessionId)) return fail('Invalid prompt: sessionId must be a non-empty string.');

        // Identity is checked before payload validation: a retry must resolve to
        // the first admission even if the retry carries a different payload.
        const existing = entries.get(id);
        if (existing) {
          if (existing.item.sessionId !== sessionId) {
            return fail(`Prompt id "${id}" is already admitted to a different session.`);
          }
          return ok(copyItem(existing.item));
        }

        if (!isNonEmptyString(text)) return fail('Invalid prompt: text must be a non-empty string.');
        if (text.length > maxTextChars) {
          return fail(`Invalid prompt: text exceeds ${maxTextChars} characters.`);
        }
        if (mode !== 'steer' && mode !== 'queue') {
          return fail('Invalid prompt: mode must be "steer" or "queue".');
        }
        if (pendingCount() >= maxItems) {
          return fail(`Prompt inbox is full (${maxItems} items).`);
        }

        const stored: IncomingPrompt = {
          id,
          sessionId,
          text,
          mode,
          enqueuedAt: typeof enqueuedAt === 'number' && Number.isFinite(enqueuedAt) ? enqueuedAt : Date.now(),
          ...(typeof control === 'boolean' ? { control } : {}),
        };
        entries.set(id, { item: stored, pending: true });
        return ok(copyItem(stored));
      } catch (error) {
        return fail(`Could not enqueue prompt: ${errorMessage(error)}`);
      }
    },

    deliverNext(sessionId, options) {
      try {
        if (!isNonEmptyString(sessionId)) return fail('sessionId must be a non-empty string.');
        const allowSteer = options?.allowSteer !== false;
        const candidates = pendingFor(sessionId);

        // The oldest pending control item is a wall: nothing admitted after it
        // can be delivered until the control itself has been delivered.
        let boundary = -1;
        for (let index = 0; index < candidates.length; index++) {
          if (candidates[index].item.control === true) {
            boundary = index;
            break;
          }
        }
        const eligible = boundary >= 0 ? candidates.slice(0, boundary + 1) : candidates;

        let chosen: Entry | undefined;
        if (allowSteer) chosen = eligible.find((entry) => entry.item.mode === 'steer');
        chosen ??= eligible.find((entry) => entry.item.mode === 'queue');
        if (!chosen) {
          return fail(`No deliverable prompt for session "${sessionId}".`);
        }

        // Flip the flag before returning the copy: the delete is atomic from a
        // caller's point of view even if several deliveries are issued at once.
        chosen.pending = false;
        return ok(copyItem(chosen.item));
      } catch (error) {
        return fail(`Could not deliver prompt: ${errorMessage(error)}`);
      }
    },

    pending(sessionId) {
      try {
        if (!isNonEmptyString(sessionId)) return [];
        return pendingFor(sessionId).map((entry) => copyItem(entry.item));
      } catch {
        return [];
      }
    },

    ack(sessionId, id) {
      try {
        if (!isNonEmptyString(sessionId) || !isNonEmptyString(id)) return false;
        const entry = entries.get(id);
        if (!entry || !entry.pending || entry.item.sessionId !== sessionId) return false;
        entry.pending = false;
        return true;
      } catch {
        return false;
      }
    },

    clear(sessionId) {
      try {
        if (!isNonEmptyString(sessionId)) return;
        for (const [id, entry] of entries) {
          if (entry.item.sessionId === sessionId) entries.delete(id);
        }
      } catch {
        // clear has no return value; best effort only.
      }
    },

    size() {
      try {
        return pendingCount();
      } catch {
        return 0;
      }
    },
  };
}

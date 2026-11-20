/**
 * memory-tools.ts — the model-facing side of working checkpoint, memory and
 * project verification.
 *
 * Kept in one file because they are three small, related "harness state" tools:
 * they neither read the workspace nor write it, so they are safe to run inside a
 * parallel batch (see agentic-loop/scheduler.ts).
 */

import { detectChecks, renderCheckReport, runChecks } from '../utils/autoverify.js';
import { addMemory, forgetMemory, formatMemoryList, listMemory, MEMORY_KINDS } from '../utils/memory.js';
import { getWorkingDirectory } from '../utils/path-validation.js';
import {
  clearWorkingCheckpoint,
  getWorkingCheckpoint,
  MAX_CHECKPOINT_CHARS,
  setWorkingCheckpoint,
  WORKING_CHECKPOINT_TOOL_DESCRIPTION,
} from '../utils/working-checkpoint.js';

export const updateWorkingCheckpointTool = {
  type: 'function' as const,
  function: {
    name: 'update_working_checkpoint',
    description: WORKING_CHECKPOINT_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: `Your notes. Max ${MAX_CHECKPOINT_CHARS} characters. Empty string clears it.`,
        },
      },
      required: ['content'],
    },
  },
};

export async function updateWorkingCheckpoint(
  args: { content?: unknown },
  sessionId?: string,
): Promise<string> {
  const content = typeof args.content === 'string' ? args.content : '';
  const applied = setWorkingCheckpoint(sessionId, content);
  if (!applied) {
    clearWorkingCheckpoint(sessionId);
    return 'Working checkpoint cleared.';
  }
  return `Working checkpoint saved (${applied.length}/${MAX_CHECKPOINT_CHARS} characters).`;
}

export const memoryAddTool = {
  type: 'function' as const,
  function: {
    name: 'memory_add',
    description:
      'Save a durable fact about the user or project (a preference, constraint or decision) that should outlive this session. Never store secrets.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One short sentence, in the third person.' },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Entry type. Defaults to note.' },
      },
      required: ['text'],
    },
  },
};

export async function memoryAdd(args: { text?: unknown; kind?: unknown }): Promise<string> {
  const text = typeof args.text === 'string' ? args.text : '';
  const result = addMemory({ text, kind: typeof args.kind === 'string' ? args.kind : 'note', source: 'tool' });
  if ('error' in result) return `Error: ${result.error}`;
  return `Saved memory ${result.id} [${result.kind}]: ${result.text}`;
}

export const memoryListTool = {
  type: 'function' as const,
  function: {
    name: 'memory_list',
    description: 'List saved memory entries, filtered by kind or search term.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to search for.' },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Only entries of this kind.' },
      },
    },
  },
};

export async function memoryList(args: { query?: unknown; kind?: unknown }): Promise<string> {
  const entries = listMemory({
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.kind === 'string' ? { kind: args.kind as any } : {}),
  });
  return formatMemoryList(entries).join('\n');
}

export const memoryForgetTool = {
  type: 'function' as const,
  function: {
    name: 'memory_forget',
    description: 'Delete a memory entry by id or by a distinctive substring.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Entry id or a distinctive substring.' },
      },
      required: ['target'],
    },
  },
};

export async function memoryForget(args: { target?: unknown }): Promise<string> {
  const target = typeof args.target === 'string' ? args.target.trim() : '';
  if (!target) return 'Error: memory_forget requires target';
  const removed = forgetMemory(target);
  return removed > 0 ? `Removed ${removed} memory entr${removed === 1 ? 'y' : 'ies'}.` : 'No matching memory entry.';
}

export const verifyProjectTool = {
  type: 'function' as const,
  function: {
    name: 'verify_project',
    description:
      'Run the checks this repo declares (typecheck, lint, test) before claiming work is done.',
    parameters: {
      type: 'object',
      properties: {
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these check names (typecheck, lint, test).',
        },
      },
    },
  },
};

export async function verifyProject(args: { only?: unknown }): Promise<string> {
  const cwd = getWorkingDirectory();
  const checks = await detectChecks({ cwd });
  if (checks.length === 0) return 'No project checks detected.';
  const only = Array.isArray(args.only)
    ? args.only.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const results = await runChecks(checks, {
    cwd,
    ...(only && only.length > 0 ? { only } : {}),
    stopOnFirstFailure: false,
  });
  return renderCheckReport(results, checks);
}

/** Current checkpoint, exposed for the UI. */
export function workingCheckpointFor(sessionId?: string): string {
  return getWorkingCheckpoint(sessionId);
}

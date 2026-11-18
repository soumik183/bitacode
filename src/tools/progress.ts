import {
  errorMessage,
  MAX_PROGRESS_LABEL_CHARS,
  PROGRESS_WIDTH,
  type ParsedProgress,
  type ProgressArgs,
} from './task-registry.js';

export const progressTool = {
  type: 'function' as const,
  function: {
    name: 'progress',
    description: 'Report progress to the user as a formatted bar with a percentage and label.',
    parameters: {
      type: 'object',
      properties: {
        percent: { type: 'number', description: 'Progress percentage, 0–100.' },
        label: { type: 'string', description: 'Short description of the current step.' },
      },
      required: ['percent'],
    },
  },
};

export async function progress(args: ProgressArgs = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const raw = typeof a.percent === 'number' ? a.percent : Number(a.percent);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
      return 'Error: percent must be a number between 0 and 100.';
    }
    const percent = Math.round(raw);
    const label = (typeof a.label === 'string' ? a.label.trim() : '').slice(0, MAX_PROGRESS_LABEL_CHARS);
    const filled = Math.round((percent / 100) * PROGRESS_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_WIDTH - filled);
    return `PROGRESS: [${bar}] ${percent}%${label ? ` — ${label}` : ''}`;
  } catch (err) {
    return errorMessage('progress', err);
  }
}

/** Parse a progress line produced by `progress`; null when it is not one. */
export function parseProgress(text: unknown): ParsedProgress | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*PROGRESS:\s*\[([█░]*)\]\s*(\d{1,3})%\s*(.*)$/.exec(text);
  if (!match) return null;
  const percent = Number(match[2]);
  if (!Number.isFinite(percent) || percent > 100) return null;
  const label = match[3].trim().replace(/^[—–-]\s*/, '').trim();
  return { percent, label };
}

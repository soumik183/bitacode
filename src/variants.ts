/**
 * Reasoning variants shown under the prompt as `model · variant · ctx`.
 * Each variant has its own color so the active level is readable at a glance.
 */
export interface Variant {
  id: string;
  label: string;
  color: string;
  /** Sent as `reasoning_effort` when supported. `none` sends nothing. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

export const VARIANTS: Variant[] = [
  { id: 'none', label: 'none', color: '#5c5c5c' },
  { id: 'minimal', label: 'minimal', color: '#5eead4', reasoningEffort: 'minimal' },
  { id: 'low', label: 'low', color: '#7dd3fc', reasoningEffort: 'low' },
  { id: 'medium', label: 'medium', color: '#60a5fa', reasoningEffort: 'medium' },
  { id: 'high', label: 'high', color: '#c084fc', reasoningEffort: 'high' },
  // shortcut: no provider exposes a "max" effort, so it maps to high
  { id: 'max', label: 'max', color: '#f472b6', reasoningEffort: 'high' },
];

export const DEFAULT_VARIANT = 'none';

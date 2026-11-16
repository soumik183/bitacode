export const VARIANTS = [
    { id: 'none', label: 'none', color: '#5c5c5c' },
    { id: 'minimal', label: 'minimal', color: '#5eead4', reasoningEffort: 'minimal' },
    { id: 'low', label: 'low', color: '#7dd3fc', reasoningEffort: 'low' },
    { id: 'medium', label: 'medium', color: '#60a5fa', reasoningEffort: 'medium' },
    { id: 'high', label: 'high', color: '#c084fc', reasoningEffort: 'high' },
    // shortcut: no provider exposes a "max" effort, so it maps to high
    { id: 'max', label: 'max', color: '#f472b6', reasoningEffort: 'high' },
];
export const DEFAULT_VARIANT = 'none';

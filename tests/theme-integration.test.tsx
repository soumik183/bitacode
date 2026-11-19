import test from 'node:test';
import assert from 'node:assert/strict';
import type { SubAgentActivityItem } from '../src/components/SubAgentActivity.js';

// Ink only emits colour escapes when the renderer believes colour is enabled.
// Set it before importing Ink so the status glyphs can be asserted by colour.
process.env.FORCE_COLOR = '3';

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { ThemeProvider, themes } = await import('../src/theme.js');
const { TodoPanel } = await import('../src/components/TodoPanel.js');
const { SubAgentActivity } = await import('../src/components/SubAgentActivity.js');

/** Same truecolor escape Ink writes for a hex prop: \x1b[38;2;r;g;bm. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

const todos = [
  { id: '1', content: 'done', status: 'completed' as const, priority: 'high' },
  { id: '2', content: 'active', status: 'in_progress' as const, priority: 'high' },
  { id: '3', content: 'waiting', status: 'pending' as const, priority: 'low' },
];

function todoFrame(name: string): string {
  const view = render(
    React.createElement(ThemeProvider, { name }, React.createElement(TodoPanel, { todos, columns: 80 }))
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

test('todo status icons use the active palette, not a module-level singleton', () => {
  const light = todoFrame('light');
  assert.ok(light.includes(`${rgb(themes.light.success)}✓ `), 'completed uses success');
  assert.ok(light.includes(`${rgb(themes.light.info)}◐ `), 'in progress uses info');
  assert.ok(light.includes(`${rgb(themes.light.dim)}○ `), 'pending uses dim');

  const black = todoFrame('black');
  assert.ok(black.includes(`${rgb(themes.black.success)}✓ `), 'success repaints on theme change');
  assert.ok(black.includes(`${rgb(themes.black.info)}◐ `), 'info repaints on theme change');
  assert.ok(!black.includes(`${rgb(themes.light.success)}✓ `), 'old palette colour is gone');
});

const activities: SubAgentActivityItem[] = [
  { id: 'a1', task: 'running', status: 'start', startedAt: 0 },
  { id: 'a2', task: 'done', status: 'done', startedAt: 0, endedAt: 10 },
  { id: 'a3', task: 'failed', status: 'error', startedAt: 0, endedAt: 10 },
];

function subAgentFrame(name: string): string {
  const view = render(
    React.createElement(
      ThemeProvider,
      { name },
      React.createElement(SubAgentActivity, { activities, columns: 80, now: 10 })
    )
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

test('sub-agent status icons use the active palette', () => {
  const sand = subAgentFrame('sand');
  assert.ok(sand.includes(`${rgb(themes.sand.info)}⠹ `), 'start uses info');
  assert.ok(sand.includes(`${rgb(themes.sand.success)}✓ `), 'done uses success');
  assert.ok(sand.includes(`${rgb(themes.sand.error)}✗ `), 'error uses error');

  const highContrast = subAgentFrame('high-contrast');
  assert.ok(highContrast.includes(`${rgb(themes['high-contrast'].error)}✗ `), 'error repaints on theme change');
  assert.ok(!highContrast.includes(`${rgb(themes.sand.error)}✗ `), 'old palette colour is gone');
});

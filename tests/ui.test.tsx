import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { ThinkingBlock, clipToPreview, thinkingBlockHeight } from '../src/components/ThinkingBlock.js';
import { ThinkingArchive, archivePreviewChars } from '../src/components/ThinkingArchive.js';
import { TodoPanel, todoPanelRows } from '../src/components/TodoPanel.js';
import { PromptInput } from '../src/components/PromptInput.js';
import { ErrorBoundary } from '../src/components/ErrorBoundary.js';
import { visibleRowWindow, sliceItemsToWindow } from '../src/utils/scroll.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from '../src/utils/scrollbar.js';

test('error boundary keeps the terminal open instead of unmounting', () => {
  const Broken = (): React.ReactNode => {
    throw new Error('render failed');
  };

  const { lastFrame } = render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>
  );

  assert.match(lastFrame() ?? '', /unexpected UI error/);
  assert.match(lastFrame() ?? '', /ctrl\+c/);
});

test('thinking block hides reasoning until expanded', () => {
  const { lastFrame } = render(
    <ThinkingBlock
      text="secret reasoning"
      expanded={false}
      active
      animate={false}
      frame={0}
      columns={80}
      rows={24}
    />
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Thinking/);
  assert.doesNotMatch(frame, /secret reasoning/);
  assert.match(frame, /click to expand/);
});

test('thinking block shows reasoning when expanded', () => {
  const { lastFrame } = render(
    <ThinkingBlock
      text="secret reasoning"
      expanded
      active={false}
      animate={false}
      frame={0}
      columns={80}
      rows={24}
    />
  );
  assert.match(lastFrame() ?? '', /Thought/);
  assert.match(lastFrame() ?? '', /secret reasoning/);
});

test('thinking block shows the live elapsed time', () => {
  const { lastFrame } = render(
    <ThinkingBlock
      text="working through it"
      expanded={false}
      active
      animate={false}
      frame={0}
      columns={80}
      rows={24}
      elapsedMs={2100}
    />
  );
  assert.match(lastFrame() ?? '', /2s/);
});

test('prompt input masks secret values', () => {
  const { lastFrame } = render(
    <PromptInput value="secret" onChange={() => {}} onSubmit={() => {}} mask />
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /\*{6}/);
  assert.doesNotMatch(frame, /secret/);
});

test('prompt input ignores SGR mouse reports', async () => {
  let value = '';

  const Harness = () => {
    const [state, setState] = React.useState('');
    value = state;
    return <PromptInput value={state} onChange={setState} onSubmit={() => {}} placeholder="type here" />;
  };

  const { stdin } = render(<Harness />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('\x1b[<0;10;5M');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(value, '');
});

test('todo panel renders live completion state', () => {
  const todos = [
    { id: '1', content: 'write tests', status: 'completed' as const, priority: 'high' as const },
    { id: '2', content: 'ship feature', status: 'in_progress' as const, priority: 'medium' as const },
    { id: '3', content: 'clean up', status: 'pending' as const, priority: 'low' as const },
  ];
  const { lastFrame } = render(<TodoPanel todos={todos} columns={80} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Tasks/);
  assert.match(frame, /1\/3 done/);
  assert.match(frame, /write tests/);
  assert.match(frame, /ship feature/);
});

test('thinking block collapses to a plain header once reasoning ends', async () => {
  const { lastFrame, rerender } = render(
    <ThinkingBlock
      text="live reasoning"
      expanded
      active
      animate={false}
      frame={0}
      columns={80}
      rows={24}
    />
  );
  // While active the preview is visible and the label is animated-style.
  assert.match(lastFrame() ?? '', /Thinking/);
  assert.match(lastFrame() ?? '', /live reasoning/);

  rerender(
    <ThinkingBlock
      text="live reasoning"
      expanded={false}
      active={false}
      animate={false}
      frame={0}
      columns={80}
      rows={24}
      elapsedMs={3000}
    />
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Thought/);
  assert.doesNotMatch(frame, /Thinking\./);
  assert.doesNotMatch(frame, /live reasoning/);
  assert.doesNotMatch(frame, /\.\.\./);
});

test('thinking preview is clipped by rows, not just characters', () => {
  // 40 short lines would previously render ~24 rows despite an 8-row budget.
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const { shown, hiddenChars } = clipToPreview(text, 74, 8, 1600);
  assert.equal(shown.split('\n').length, 8);
  assert.ok(hiddenChars > 0);
});

test('collapsed thinking block stays a two-row header', () => {
  assert.equal(thinkingBlockHeight('anything at all', false, 80, 24), 2);
  const { lastFrame } = render(
    <ThinkingBlock text="anything at all" expanded={false} active={false} animate={false} frame={0} columns={80} rows={24} />
  );
  assert.equal((lastFrame() ?? '').split('\n').length, 2);
});

test('todo panel keeps the in-progress item visible in a long list', () => {
  const todos = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    content: `task number ${i}`,
    status: (i === 8 ? 'in_progress' : 'pending') as 'pending' | 'in_progress',
    priority: 'low' as const,
  }));
  const { lastFrame } = render(<TodoPanel todos={todos} columns={80} maxVisible={3} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /task number 8/);
  assert.match(frame, /more/);
});

test('archive preview uses the terminal width instead of a fixed cut', () => {
  const text = `${'a'.repeat(300)} END`;
  const wide = render(<ThinkingArchive text={text} elapsedMs={1000} columns={120} />).lastFrame() ?? '';
  const narrow = render(<ThinkingArchive text={text} elapsedMs={1000} columns={60} />).lastFrame() ?? '';
  assert.ok(archivePreviewChars(120) > archivePreviewChars(60));
  assert.ok(wide.length > narrow.length);
});

test('transcript renders only the visible rows and a scrollbar', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, rows: 1 }));
  const { first, last } = visibleRowWindow(40, 10, 0);
  const slice = sliceItemsToWindow(items, first, last);
  const rail = scrollbarLines(scrollbarGeometry(40, 10, 0));

  const { lastFrame } = render(
    <Box flexDirection="column" height={12}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexGrow={1} overflow="hidden" flexDirection="column">
          {slice.items.map((item) => (
            <Text key={item.id}>{item.id}</Text>
          ))}
        </Box>
        <Box flexDirection="column" width={1}>
          {rail.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      </Box>
      <Text>COMPOSER</Text>
    </Box>
  );

  const frame = lastFrame() ?? '';
  // Only the tail of the transcript is drawn.
  assert.doesNotMatch(frame, /^r0$/m);
  assert.match(frame, /\br39\b/);
  assert.match(frame, /COMPOSER/);
  assert.match(frame, new RegExp(SCROLLBAR_THUMB));
  assert.equal(slice.items.length, 10);
});

test('todo panel row estimate matches what it renders', () => {
  const todos = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    content: `task ${i}`,
    status: 'pending' as const,
    priority: 'low' as const,
  }));

  for (const maxVisible of [1, 2, 3, 5, 6]) {
    const { lastFrame } = render(<TodoPanel todos={todos} columns={80} maxVisible={maxVisible} />);
    const rendered = (lastFrame() ?? '').split('\n').length;
    assert.equal(
      todoPanelRows(todos, maxVisible),
      rendered,
      `rows must match the render at maxVisible=${maxVisible}`
    );
  }
  // With nothing left to scroll the estimate is just header + tasks + margin.
  assert.equal(todoPanelRows(todos.slice(0, 2), 5), 4);
});

test('thinking block shows only when the provider streams reasoning', () => {
  // Empty reasoning must render nothing at all, not an empty "Thinking..." row.
  const empty = render(
    <ThinkingBlock text="" expanded={false} active={false} animate={false} frame={0} columns={80} rows={24} />
  );
  assert.equal((empty.lastFrame() ?? '').trim(), '');

  // A provider that does send reasoning still gets the live block.
  const live = render(
    <ThinkingBlock
      text="provider reasoning"
      expanded
      active
      animate={false}
      frame={0}
      columns={80}
      rows={24}
    />
  );
  assert.match(live.lastFrame() ?? '', /Thinking/);
  assert.match(live.lastFrame() ?? '', /provider reasoning/);
});

test('thinking header still shows the thought once reasoning finishes', () => {
  const finished = render(
    <ThinkingBlock
      text="provider reasoning"
      expanded={false}
      active={false}
      animate={false}
      frame={0}
      columns={80}
      rows={24}
      elapsedMs={1200}
    />
  );
  const frame = finished.lastFrame() ?? '';
  assert.match(frame, /Thought/);
  assert.doesNotMatch(frame, /Thinking\.\.\./);
});

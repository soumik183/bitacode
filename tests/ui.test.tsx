import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { settle, waitForFrame } from './helpers/wait.js';
import { App } from '../src/App.js';
import { getApprovalMode, setApprovalMode } from '../src/utils/approval.js';
import { ThinkingBlock, clipToPreview, thinkingBlockHeight } from '../src/components/ThinkingBlock.js';
import { ThinkingArchive, archivePreviewChars } from '../src/components/ThinkingArchive.js';
import { TodoPanel, todoPanelRows } from '../src/components/TodoPanel.js';
import { PromptInput } from '../src/components/PromptInput.js';
import { ErrorBoundary } from '../src/components/ErrorBoundary.js';
import { maxScrollOffset, visibleRowWindow, sliceItemsToWindow } from '../src/utils/scroll.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from '../src/utils/scrollbar.js';
import stripAnsi from 'strip-ansi';

const plain = (frame: string): string => stripAnsi(frame);

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

test('prompt input keeps a very long value on a single row', () => {
  const { lastFrame } = render(
    <PromptInput value={'x'.repeat(200)} onChange={() => {}} onSubmit={() => {}} />
  );
  const frame = plain(lastFrame() ?? '');
  assert.equal(frame.split('\n').length, 1, 'long text must never wrap the composer');
});

test('prompt input scrolls a long value so the tail and cursor stay visible', () => {
  const value = `${'A'.repeat(40)}TAILEND`;
  const { lastFrame } = render(
    <PromptInput value={value} onChange={() => {}} onSubmit={() => {}} width={20} />
  );
  const frame = plain(lastFrame() ?? '');
  assert.equal(frame.split('\n').length, 1);
  assert.ok(frame.length <= 20, `visible width ${frame.length} must be <= 20`);
  assert.match(frame, /TAILEND$/, 'the tail is visible with the cursor at the end');
});

test('prompt input scrolls the window when the cursor moves into the middle', async () => {
  // One write per arrow: ink-testing-library only dispatches one key per write.
  const value = `${'A'.repeat(40)}MIDDLE-MARK${'B'.repeat(20)}END`;
  const Harness = () => {
    const [state] = React.useState(value);
    return <PromptInput value={state} onChange={() => {}} onSubmit={() => {}} width={20} />;
  };
  const { stdin, lastFrame } = render(<Harness />);
  await settle();
  assert.match(plain(lastFrame() ?? ''), /END$/, 'starts at the tail');

  for (let i = 0; i < 27; i++) {
    stdin.write('\x1b[D');
    await settle(30);
  }
  await settle(50);

  const frame = plain(lastFrame() ?? '');
  assert.equal(frame.split('\n').length, 1);
  assert.ok(frame.length <= 20, `visible width ${frame.length} must be <= 20`);
  assert.match(frame, /MIDDLE/, 'the window follows the cursor into the middle');
  assert.doesNotMatch(frame, /END/, 'the tail scrolled out of view');
});

test('prompt input budgets wide characters by display columns', () => {
  const { lastFrame } = render(
    <PromptInput value={'漢'.repeat(20)} onChange={() => {}} onSubmit={() => {}} width={10} />
  );
  const frame = plain(lastFrame() ?? '');
  assert.equal(frame.split('\n').length, 1);
  assert.ok(frame.length <= 5, `${frame.length} wide chars exceed 10 columns`);
});

test('prompt input keeps a long masked value on one row', () => {
  const { lastFrame } = render(
    <PromptInput value={'s'.repeat(200)} onChange={() => {}} onSubmit={() => {}} width={20} mask />
  );
  const frame = plain(lastFrame() ?? '');
  assert.equal(frame.split('\n').length, 1);
  assert.ok(frame.length <= 20, `visible width ${frame.length} must be <= 20`);
  assert.match(frame.trimEnd(), /^\*+$/, 'only asterisks are visible');
});

// Tracks the committed value so key-driven tests can assert whole-glyph edits.
function valueHarness(initial: string) {
  let current = initial;
  const Harness: React.FC = () => {
    const [state, setState] = React.useState(initial);
    current = state;
    return <PromptInput value={state} onChange={setState} onSubmit={() => {}} />;
  };
  return { Harness, value: () => current };
}

test('prompt input backspace removes a whole emoji instead of half a surrogate pair', async () => {
  const { Harness, value } = valueHarness('a😀b');
  const { stdin } = render(<Harness />);
  await settle();
  stdin.write('\x7f'); // delete 'b'
  await settle(30);
  stdin.write('\x7f'); // must delete the whole emoji, not one UTF-16 unit
  await settle(50);
  assert.equal(value(), 'a');
});

test('prompt input arrows keep the cursor on emoji glyph boundaries', async () => {
  const { Harness, value } = valueHarness('😀b');
  const { stdin } = render(<Harness />);
  await settle();
  for (let i = 0; i < 3; i++) {
    stdin.write('\x1b[D');
    await settle(30);
  }
  stdin.write('\x1b[C');
  await settle(30);
  stdin.write('X');
  await settle(50);
  // A UTF-16 cursor would land between the surrogate halves and split 😀.
  assert.equal(value(), '😀Xb');
});

test('prompt input CJK arrows and backspace land on whole glyphs', async () => {
  const { Harness, value } = valueHarness('漢字');
  const { stdin } = render(<Harness />);
  await settle();
  stdin.write('\x1b[D'); // before 字
  await settle(30);
  stdin.write('X');
  await settle(30);
  assert.equal(value(), '漢X字');
  stdin.write('\x7f'); // removes X, not half of a glyph
  await settle(50);
  assert.equal(value(), '漢字');
});

test('prompt input mask shows one star per glyph, not per UTF-16 unit', () => {
  const { lastFrame } = render(
    <PromptInput value="a😀漢b" onChange={() => {}} onSubmit={() => {}} mask />
  );
  assert.equal(plain(lastFrame() ?? '').trim(), '****');
});

test('prompt input ignores SGR mouse reports', async () => {
  let value = '';

  const Harness = () => {
    const [state, setState] = React.useState('');
    value = state;
    return <PromptInput value={state} onChange={setState} onSubmit={() => {}} placeholder="type here" />;
  };

  const { stdin } = render(<Harness />);
  await settle();
  stdin.write('\x1b[<0;10;5M');
  await settle(50);

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

test('archived thinking expands to the full reasoning on click', () => {
  const text = `${'first line '.repeat(40)}\nSECOND LINE`;
  const collapsed = render(
    <ThinkingArchive text={text} elapsedMs={1000} columns={80} />
  ).lastFrame() ?? '';
  assert.match(collapsed, /Thought/);
  assert.match(collapsed, /click to expand/);
  assert.doesNotMatch(collapsed, /SECOND LINE/);

  const expanded = render(
    <ThinkingArchive text={text} elapsedMs={1000} columns={80} expanded />
  ).lastFrame() ?? '';
  assert.match(expanded, /click to collapse/);
  assert.match(expanded, /SECOND LINE/);
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

test('a partially scrolled first item is clipped, not replaced by blank rows', () => {
  // One 20-row item, a 10-row content window scrolled to the bottom shows
  // rows 10..19. trimTop is the number of rows to hide at the item's top.
  const body = Array.from({ length: 20 }, (_, i) => `row${String(i).padStart(2, '0')}`).join('\n');
  const { first, last } = visibleRowWindow(20, 10, 0);
  const slice = sliceItemsToWindow([{ id: 'big', rows: 20 }], first, last);
  assert.equal(slice.trimTop, 10);

  // This mirrors App's viewport JSX: one breathing-room row, then the first
  // item shifted up inside a clipped, fixed-height box.
  const { lastFrame } = render(
    <Box flexDirection="column" height={11} overflow="hidden">
      <Box height={1} flexShrink={0} />
      <Box height={20 - slice.trimTop} overflow="hidden" flexShrink={0}>
        <Box marginTop={-slice.trimTop} flexShrink={0}>
          <Text>{body}</Text>
        </Box>
      </Box>
    </Box>
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /row10/, 'first visible row is the trimmed item row 10');
  assert.match(frame, /row19/, 'last visible row is the item bottom');
  assert.doesNotMatch(frame, /row0[0-9]/, 'rows above the trim are hidden');
  // Only the single breathing-room row is blank; a trim spacer would show ten.
  const contentRows = frame.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(contentRows.length, 10);
  assert.ok(contentRows.every((line) => /row\d\d/.test(line)));
});

test('max scroll uses the rendered window so the oldest row stays reachable', () => {
  const transcriptRows = 20;
  const viewportRows = 11;
  const windowRows = viewportRows - 1; // TOP_PAD
  const max = maxScrollOffset(transcriptRows, windowRows);
  const window = visibleRowWindow(transcriptRows, windowRows, max);
  assert.equal(window.first, 0, 'oldest row is visible at max scroll');

  // The old arithmetic clamped against the full viewport, leaving row 0
  // permanently out of reach.
  const oldMax = maxScrollOffset(transcriptRows, viewportRows);
  assert.equal(visibleRowWindow(transcriptRows, windowRows, oldMax).first, 1);
});

// ─── Full-App UI tests (composer, settings, global shortcuts) ───
// Home is redirected to a temp dir so config, settings and sessions are
// isolated. Cwd is left alone: every store this touches lives under HOME.
function renderApp() {
  const originalHome = process.env.HOME;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-ui-'));
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'bitacode.jsonc'),
    JSON.stringify({
      providers: { openai: { apiKey: 'test-key', models: { 'gpt-4o-mini': {} } } },
      mcp: { servers: {} },
    })
  );
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'settings.json'),
    JSON.stringify({
      animations: false,
      mouseClicks: false,
      variant: 'none',
      approvalMode: 'manual',
    })
  );

  const instance = render(<App />);
  return {
    ...instance,
    cleanupAll() {
      instance.unmount();
      instance.cleanup();
      process.env.HOME = originalHome;
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      setApprovalMode('manual');
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('the composer placeholder appears exactly once in the frame', async () => {
  const app = renderApp();
  try {
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    const rows = frame.split('\n').filter((line) => line.includes('Build anything…'));
    assert.equal(rows.length, 1, `composer was duplicated:\n${frame}`);
  } finally {
    app.cleanupAll();
  }
});

test('opening help never pushes the composer or footer off screen', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    app.stdin.write('\x1bh'); // Alt+h
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes('Keys (ctrl or alt)'));
    assert.match(frame, /Build anything…/, 'composer stays visible while help is open');
    assert.match(frame, /📁/, 'footer stays visible while help is open');
  } finally {
    app.cleanupAll();
  }
});

// Raw stdout writes (mouse reporting) can become ink-testing-library's
// `lastFrame()`. Scan the frame history for the most recent real render.
function waitForFrameText(
  app: ReturnType<typeof renderApp>,
  text: string,
  timeoutMs = 5000,
  fromIndex = 0
): Promise<string> {
  return waitForFrameWhere(app, (f) => f.includes(text), timeoutMs, fromIndex);
}

function waitForFrameWhere(
  app: ReturnType<typeof renderApp>,
  predicate: (frame: string) => boolean,
  timeoutMs = 5000,
  fromIndex = 0
): Promise<string> {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeoutMs) {
      for (let i = app.stdout.frames.length - 1; i >= fromIndex; i--) {
        const frame = plain(app.stdout.frames[i] ?? '');
        if (predicate(frame)) return frame;
      }
      await settle(20);
    }
    return '';
  })();
}

test('settings palette shows approval mode and cycles manual -> auto -> yolo', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    // ctrl+, opens settings (some terminals emit the raw control byte \x1c).
    app.stdin.write('\x1c');
    const frame = await waitForFrameText(app, 'Approval mode');
    assert.match(frame, /Approval mode/);
    assert.match(frame, /manual/, 'current approval mode is shown in the description');

    // Rows: 0 animations, 1 mouse clicks, 2 approval mode. Move to the last.
    // Terminal input can be dropped under parallel test load, so retry a key
    // until the selection marker actually moves.
    const moveDownUntil = async (marker: string) => {
      await settle(80);
      for (let attempt = 0; attempt < 6; attempt++) {
        app.stdin.write('\x1b[B');
        const hit = await waitForFrameWhere(app, (f) => f.includes(marker), 1200);
        if (hit) return hit;
      }
      return '';
    };
    const settingsFrame = (f: string, mode: string) =>
      f.includes('Settings') && f.includes('Approval mode') && f.includes(mode);
    assert.ok(await moveDownUntil('› Mouse click thinking'), 'moved to mouse setting');
    assert.ok(await moveDownUntil('› Approval mode'), 'moved to approval setting');

    // Poll global state (not frames): raw stdout writes can clobber lastFrame
    // under parallel load. Retry Enter in case a key is dropped.
    const cycleTo = async (mode: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        app.stdin.write('\r');
        const start = Date.now();
        while (Date.now() - start < 1200) {
          if (getApprovalMode() === mode) return;
          await settle(20);
        }
      }
    };

    await cycleTo('auto');
    assert.equal(getApprovalMode(), 'auto', 'setApprovalMode runs immediately on cycle');
    await waitForFrameWhere(app, (f) => settingsFrame(f, 'auto'));

    await cycleTo('yolo');
    assert.equal(getApprovalMode(), 'yolo');

    await cycleTo('manual');
    assert.equal(getApprovalMode(), 'manual', 'cycling wraps back around');
  } finally {
    app.cleanupAll();
  }
});

test('alt+h toggles help and ctrl+k clears the prompt', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));

    app.stdin.write('\x1bh'); // Alt+h -> key.meta
    let frame = await waitForFrame(app.lastFrame, (f) => f.includes('Keys (ctrl or alt)'));
    assert.match(frame, /Approval mode:/, 'help shows the current approval mode');
    assert.match(frame, /ctrl or alt/);

    app.stdin.write('\x1bh');
    await waitForFrame(app.lastFrame, (f) => !f.includes('Keys (ctrl or alt)'));

    const typedAt = app.stdout.frames.length;
    app.stdin.write('draft');
    frame = await waitForFrameText(app, 'draft', 2000, typedAt);
    assert.ok(frame.includes('draft'));

    app.stdin.write('\x0b'); // ctrl+k
    frame = await waitForFrameText(app, 'Build anything…', 2000, typedAt);
    assert.doesNotMatch(frame, /draft/, 'ctrl+k clears the current input');
  } finally {
    app.cleanupAll();
  }
});

test('ctrl+n starts a new session and clears the draft', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    const typedAt = app.stdout.frames.length;
    app.stdin.write('unsent draft');
    await waitForFrameText(app, 'unsent draft', 2000, typedAt);

    app.stdin.write('\x0e'); // ctrl+n
    const frame = await waitForFrameText(app, 'Build anything…', 2000, typedAt);
    assert.doesNotMatch(frame, /unsent draft/, '/new clears the input without leaking the old draft');
  } finally {
    app.cleanupAll();
  }
});

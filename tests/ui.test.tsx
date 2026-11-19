import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { render as renderInk } from 'ink';
import { settle, waitFor, waitForFrame } from './helpers/wait.js';
import { App, type AppProps } from '../src/App.js';
import { getUserRuntimeConfigPath, readConfig } from '../src/config.js';
import { getAllProviders } from '../src/providers/index.js';
import { resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { getApprovalMode, setApprovalMode, requestApproval } from '../src/utils/approval.js';
import { ThinkingBlock, clipToPreview, thinkingBlockHeight } from '../src/components/ThinkingBlock.js';
import { ThinkingArchive, archivePreviewChars } from '../src/components/ThinkingArchive.js';
import { TodoPanel, todoPanelRows } from '../src/components/TodoPanel.js';
import {
  SubAgentActivity,
  subAgentActivityRows,
  subAgentActivitySummary,
  upsertSubAgentActivity,
  type SubAgentActivityItem,
} from '../src/components/SubAgentActivity.js';
import { PromptInput } from '../src/components/PromptInput.js';
import { AskPrompt } from '../src/components/AskPrompt.js';
import { ApprovalPrompt } from '../src/components/ApprovalPrompt.js';
import { ApiKeyPrompt } from '../src/components/ApiKeyPrompt.js';
import { themes, THEME_NAMES } from '../src/theme.js';
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
    await settle(80);
  }
  await settle(100);

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
  await settle(80);
  stdin.write('\x7f'); // must delete the whole emoji, not one UTF-16 unit
  await settle(100);
  assert.equal(value(), 'a');
});

test('prompt input arrows keep the cursor on emoji glyph boundaries', async () => {
  const { Harness, value } = valueHarness('😀b');
  const { stdin } = render(<Harness />);
  await settle();
  for (let i = 0; i < 3; i++) {
    stdin.write('\x1b[D');
    await settle(80);
  }
  stdin.write('\x1b[C');
  await settle(80);
  stdin.write('X');
  await settle(100);
  // A UTF-16 cursor would land between the surrogate halves and split 😀.
  assert.equal(value(), '😀Xb');
});

test('prompt input CJK arrows and backspace land on whole glyphs', async () => {
  const { Harness, value } = valueHarness('漢字');
  const { stdin } = render(<Harness />);
  await settle();
  stdin.write('\x1b[D'); // before 字
  await settle(80);
  stdin.write('X');
  await settle(80);
  assert.equal(value(), '漢X字');
  stdin.write('\x7f'); // removes X, not half of a glyph
  await settle(100);
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
  await settle(100);

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

test('todo panel never overflows a narrow terminal', () => {
  const todos = [
    { id: '1', content: 'a very long task description that must be clipped', status: 'in_progress' as const, priority: 'high' as const },
    { id: '2', content: 'another long task description here', status: 'pending' as const, priority: 'medium' as const },
    { id: '3', content: 'one more long task', status: 'completed' as const, priority: 'low' as const },
  ];
  for (const columns of [8, 20, 30]) {
    const { lastFrame } = render(
      <Box width={columns}>
        <TodoPanel todos={todos} columns={columns} maxVisible={3} />
      </Box>
    );
    const frame = plain(lastFrame() ?? '');
    assert.ok(
      lineWidth(frame) <= columns,
      `todo panel is ${lineWidth(frame)} columns wide at ${columns} columns`
    );
  }
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

test('thinking block height matches the rendered row count for multi-line reasoning', () => {
  const cases = [
    'first line\nsecond line\nthird line',
    Array.from({ length: 40 }, (_, i) => `line ${i} with some content here`).join('\n'),
  ];
  for (const text of cases) {
    for (const expanded of [false, true]) {
      const estimate = thinkingBlockHeight(text, expanded, 80, 24);
      const { lastFrame } = render(
        <ThinkingBlock
          text={text}
          expanded={expanded}
          active={false}
          animate={false}
          frame={0}
          columns={80}
          rows={24}
        />
      );
      const actual = (lastFrame() ?? '').split('\n').length;
      assert.equal(estimate, actual, `estimate must match rendered rows (expanded=${expanded})`);
    }
  }
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

test('archived thinking keeps each reasoning line and expands to all of them on click', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `thought line ${i}`);
  const text = lines.join('\n');

  const collapsed = plain(render(
    <ThinkingArchive text={text} elapsedMs={1000} columns={80} />
  ).lastFrame() ?? '');
  assert.match(collapsed, /Thought/);
  assert.match(collapsed, /click to expand/);

  // Each kept line is its own row, in order — never flattened with `/\s+/g`.
  const collapsedRows = collapsed.split('\n').map((row) => row.trim());
  for (const line of lines.slice(0, 6)) {
    assert.ok(collapsedRows.includes(line), `collapsed preview is missing "${line}"`);
  }
  assert.doesNotMatch(collapsed, /thought line 6/);
  assert.match(collapsed, /… 4 more lines · click to expand/);
  assert.doesNotMatch(collapsed, /thought line 0 thought line 1/);

  const expanded = plain(render(
    <ThinkingArchive text={text} elapsedMs={1000} columns={80} expanded />
  ).lastFrame() ?? '');
  assert.match(expanded, /click to collapse/);
  const expandedRows = expanded.split('\n').map((row) => row.trim());
  for (const line of lines) {
    assert.ok(expandedRows.includes(line), `expanded view is missing "${line}"`);
  }
  assert.doesNotMatch(expanded, /more lines/);
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
function renderApp(props: AppProps = {}, beforeRender?: (home: string) => void) {
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
  beforeRender?.(home);

  const instance = render(<App {...props} />);
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

/** Ink-testing-library can drop a keystroke under parallel load: retry it. */
async function pressUntil(
  app: ReturnType<typeof renderApp>,
  key: string,
  predicate: (frame: string) => boolean,
  timeoutMs = 5000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const from = app.stdout.frames.length;
    app.stdin.write(key);
    const hit = await waitForFrameWhere(app, predicate, 600, from);
    if (hit) return hit;
  }
  return '';
}

/** Type text into the composer and submit, retrying dropped keystrokes. */
async function typeSubmit(app: ReturnType<typeof renderApp>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    app.stdin.write('\x0b'); // ctrl+k clears the current draft
    await settle(60);
    const from = app.stdout.frames.length;
    app.stdin.write(text);
    await settle(120);
    if (await waitForFrameWhere(app, (f) => f.includes(text), 600, from)) {
      app.stdin.write('\r');
      return;
    }
  }
}

/** Seed a resumable session in an isolated test HOME. */
function seedSession(home: string, id: string, completionMessages: unknown[]): void {
  const dir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'ui test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'gpt-4o-mini',
      provider: 'openai',
      todos: [],
      completionMessages,
    })
  );
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

test('resuming a session replays saved reasoning line by line before its answer, once', async () => {
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-reasoning-replay-'));
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
    JSON.stringify({ animations: false, mouseClicks: false, variant: 'none', approvalMode: 'manual' })
  );

  const id = 'reason01';
  const dir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'gpt-4o-mini',
      provider: 'openai',
      todos: [],
      completionMessages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'FINAL-ANSWER-MARKER',
          reasoning: 'THOUGHT-STEP-ONE\nTHOUGHT-STEP-TWO\nTHOUGHT-STEP-THREE',
        },
      ],
    })
  );

  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<App sessionId={id} />);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes('FINAL-ANSWER-MARKER'), 6000);
    assert.match(frame, /Thought/, 'saved reasoning is replayed as a thought card');
    assert.equal((frame.match(/Thought/g) ?? []).length, 1, 'the thought card appears exactly once');
    assert.equal((frame.match(/FINAL-ANSWER-MARKER/g) ?? []).length, 1, 'the answer appears once');

    const rows = frame.split('\n').map((row) => row.trim());
    for (const step of ['THOUGHT-STEP-ONE', 'THOUGHT-STEP-TWO', 'THOUGHT-STEP-THREE']) {
      assert.ok(rows.includes(step), `replayed reasoning is missing the line "${step}"`);
    }
    assert.ok(
      frame.indexOf('THOUGHT-STEP-ONE') < frame.indexOf('FINAL-ANSWER-MARKER'),
      'the reasoning card is replayed above its answer'
    );
  } finally {
    instance?.unmount();
    instance?.cleanup();
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
    setApprovalMode('manual');
  }
});

test('replayed transcript frame orders user message, thought card, then answer', async () => {
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-frame-order-'));
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
    JSON.stringify({ animations: false, mouseClicks: false, variant: 'none', approvalMode: 'manual' })
  );

  const id = 'order001';
  const dir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'gpt-4o-mini',
      provider: 'openai',
      todos: [],
      completionMessages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'USER-MARKER' },
        {
          role: 'assistant',
          content: 'ANSWER-MARKER',
          reasoning: 'THOUGHT-MARKER',
        },
      ],
    })
  );

  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<App sessionId={id} />);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes('ANSWER-MARKER'), 6000);
    const user = frame.indexOf('USER-MARKER');
    const thought = frame.indexOf('THOUGHT-MARKER');
    const answer = frame.indexOf('ANSWER-MARKER');
    assert.ok(user >= 0, 'the user message is in the frame');
    assert.ok(thought >= 0, 'the thought card is in the frame');
    assert.ok(answer >= 0, 'the answer is in the frame');
    assert.ok(user < thought, `user message (${user}) must precede the thought card (${thought})`);
    assert.ok(thought < answer, `thought card (${thought}) must precede the answer (${answer})`);
  } finally {
    instance?.unmount();
    instance?.cleanup();
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
    setApprovalMode('manual');
  }
});

test('launching with no config shows the main screen and a setup hint, not a wizard', async () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-no-config-'));
  process.env.HOME = home;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.BITACODE_API_KEY;
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'bitacode', 'bitacode.jsonc'), JSON.stringify({
    providers: {}, mcp: { servers: {} },
  }));
  resetRuntimeConfigForTests();
  process.chdir(home);

  try {
    const { lastFrame } = render(<App />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes('Build anything…'));
    assert.match(frame, /No provider configured/, 'setup hint is visible');
    assert.doesNotMatch(frame, /Choose where to configure/, 'no blocking wizard on launch');
    assert.match(frame, /📁/, 'footer is visible');
  } finally {
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
    process.chdir(originalCwd);
    resetRuntimeConfigForTests();
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

test('update notice renders once, keeps the composer/footer, and hides while help is open', async () => {
  const app = renderApp({ updateNotice: 'Update available: v0.1.23 — run "bitacode update"' });
  try {
    const frame = plain(await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…')));
    assert.equal(
      (frame.match(/Update available/g) ?? []).length,
      1,
      `notice must appear exactly once:\n${frame}`
    );
    assert.match(frame, /v0\.1\.23/, 'notice message is shown');
    assert.match(frame, /Build anything…/, 'composer stays visible with the notice');
    assert.match(frame, /📁|ctx/, 'footer stays visible with the notice');

    // Help takes over the live area; the notice must step aside.
    app.stdin.write('\x1bh'); // Alt+h
    const helpFrame = plain(await waitForFrame(app.lastFrame, (f) => f.includes('Keys (ctrl or alt)')));
    assert.doesNotMatch(helpFrame, /Update available/, 'notice is hidden while help is open');
    assert.match(helpFrame, /Build anything…/, 'composer stays visible with help open');

    // Closing help brings the notice back.
    app.stdin.write('\x1bh');
    const closedFrame = plain(await waitForFrame(
      app.lastFrame,
      (f) => !f.includes('Keys (ctrl or alt)') && f.includes('Build anything…')
    ));
    assert.match(closedFrame, /Update available/, 'notice returns after help closes');
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
  app: { stdout: { frames: string[] } },
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

    // Rows: 0 animations, 1 mouse clicks, 2 approval mode. pressUntil retries
    // keys dropped under parallel load and waits for the marker, not a timer.
    const settingsFrame = (f: string, mode: string) =>
      f.includes('Settings') && f.includes('Approval mode') && f.includes(mode);
    assert.ok(await pressUntil(app, '\x1b[B', (f) => f.includes('› Mouse click thinking')), 'moved to mouse setting');
    assert.ok(await pressUntil(app, '\x1b[B', (f) => f.includes('› Approval mode')), 'moved to approval setting');

    // Poll global state (not frames): raw stdout writes can clobber lastFrame
    // under parallel load. Retry Enter in case a key is dropped.
    const cycleTo = async (mode: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        app.stdin.write('\r');
        try {
          await waitFor(() => getApprovalMode() === mode, 1200);
          return;
        } catch {
          // dropped key — try again
        }
      }
      assert.fail(`approval mode never reached ${mode}`);
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

/** Ink wires stdin one effect after the first painted frame; wait for it. */
async function waitForInput(app: ReturnType<typeof renderApp>): Promise<void> {
  await waitFor(
    () => app.stdin.listenerCount('readable') > 0,
    3000,
    'Ink never attached its stdin listener'
  );
}

/** Send a key once and wait for its frame. Retries would queue a duplicate
 * arrow/Enter press, which overshoots the row or closes the picker again. */
async function pressOnce(
  app: ReturnType<typeof renderApp>,
  key: string,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000
): Promise<string> {
  app.stdin.write(key);
  const hit = await waitForFrameWhere(app, predicate, timeoutMs);
  // Ink re-registers useInput effects after the frame; flush before the next key.
  await new Promise((resolve) => setImmediate(resolve));
  return hit;
}

/** Open the theme picker from the Settings dialog using the Theme row. */
async function openThemeFromSettings(app: ReturnType<typeof renderApp>): Promise<string> {
  await waitForInput(app);
  app.stdin.write('\x1c'); // ctrl+, opens settings
  await waitForFrameText(app, 'Approval mode');
  await new Promise((resolve) => setImmediate(resolve));
  for (const marker of ['› Mouse click thinking', '› Approval mode', '› Theme']) {
    assert.ok(await pressOnce(app, '\x1b[B', (f) => f.includes(marker)), `${marker} selected`);
  }
  // Enter must be sent once: a second press would select the highlighted
  // palette and close the picker we are trying to inspect.
  app.stdin.write('\r');
  const frame = await waitForFrameWhere(app, (f) => f.includes('1-5 pick'), 3000);
  assert.ok(frame, 'Theme row opened the picker');
  // The frame paints before Ink re-registers useInput for the new picker.
  await new Promise((resolve) => setImmediate(resolve));
  return frame;
}

/** Type /theme and submit, retrying keys dropped under parallel load. */
async function openThemeViaSlash(app: ReturnType<typeof renderApp>): Promise<string> {
  await waitForInput(app);
  for (let attempt = 0; attempt < 6; attempt++) {
    app.stdin.write('\x0b'); // ctrl+k clears the draft
    const from = app.stdout.frames.length;
    app.stdin.write('/theme');
    if (!(await waitForFrameWhere(app, (f) => f.includes('/theme'), 1500, from))) continue;
    await new Promise((resolve) => setImmediate(resolve));
    // One Enter only — a second would immediately pick a palette and close it.
    app.stdin.write('\r');
    const frame = await waitForFrameWhere(app, (f) => f.includes('1-5 pick'), 3000, from);
    if (frame) {
      // Let Ink re-register useInput for the picker before sending more keys.
      await new Promise((resolve) => setImmediate(resolve));
      return frame;
    }
  }
  return '';
}

/** OSC 11 canvas writes are an observable proxy for the active palette. */
function themeCanvas(app: ReturnType<typeof renderApp>) {
  const canvas = (name: keyof typeof themes) => `\x1b]11;${themes[name].bg}\x07`;
  return {
    painted: (name: keyof typeof themes) =>
      app.stdout.frames.some((frame) => frame.includes(canvas(name))),
  };
}

test('theme picker from settings lists all five palettes with live swatches', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    const frame = await openThemeFromSettings(app);
    assert.match(frame, /Theme/, 'theme picker is open');
    for (const name of THEME_NAMES) {
      assert.ok(frame.includes(name), `palette ${name} is listed`);
    }
    assert.equal(
      (frame.match(/■/g) ?? []).length,
      THEME_NAMES.length,
      'each palette shows a colour swatch'
    );
    assert.ok(frame.includes('warm gold on near-black'), 'black intent is shown');
    assert.ok(frame.includes('maximum contrast'), 'high-contrast intent is shown');
    assert.match(frame, /current/, 'the active palette is marked current');
  } finally {
    app.cleanupAll();
  }
});

test('theme selection repaints the full UI palette', async () => {
  const app = renderApp();
  const { painted } = themeCanvas(app);
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    assert.ok(painted('black'), 'new installs paint the black canvas');

    await openThemeFromSettings(app);
    // Palette 2 is sand; the picker accepts 1-5 as a direct pick.
    assert.ok(await pressOnce(app, '2', (f) => f.includes('Theme: sand')), 'sand was picked');
    await waitFor(() => painted('sand'), 2000, 'theme palette did not repaint');
    assert.ok(painted('sand'), 'canvas follows the choice');
    assert.ok(
      await pressOnce(app, '\x1c', (f) => f.includes('Settings') && f.includes('sand')),
      'settings show the selected palette'
    );
  } finally {
    app.cleanupAll();
  }
});

test('/theme opens the picker and arrow + enter saves settings.theme', async () => {
  const app = renderApp();
  const { painted } = themeCanvas(app);
  const settingsFile = () => path.join(process.env.HOME!, '.config', 'bitacode', 'settings.json');
  const savedTheme = () =>
    (JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as { theme?: string }).theme;
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    const frame = await openThemeViaSlash(app);
    assert.match(frame, /Theme/, '/theme opens the theme picker');

    // Move down to 'light' (index 3) and confirm with Enter.
    for (const marker of ['› ■ sand', '› ■ dark', '› ■ light']) {
      assert.ok(await pressOnce(app, '\x1b[B', (f) => f.includes(marker)), `${marker} selected`);
    }
    assert.ok(
      await pressOnce(app, '\r', (f) => f.includes('Theme: light'), 3000),
      'light was picked'
    );
    await waitFor(() => painted('light'), 2000, 'light canvas did not repaint');
    await waitFor(() => savedTheme() === 'light', 2000, 'settings.theme was not saved');
    assert.equal(savedTheme(), 'light');
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

// ─── Sub-agent activity tests ───
test('sub-agent activity panel renders a synthetic event with status, task, tools and elapsed', () => {
  const startedAt = 1_000_000;
  let items: SubAgentActivityItem[] = [];
  items = upsertSubAgentActivity(items, {
    subAgentId: 'sub-agent-abc123',
    subAgentLabel: 'Explore',
    subAgentStatus: 'start',
    subAgentTask: 'find all TODOs',
  }, startedAt);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'start');
  assert.equal(items[0].task, 'find all TODOs');

  items = upsertSubAgentActivity(items, {
    subAgentId: 'sub-agent-abc123',
    subAgentTool: { tool: 'grep_search', status: 'running', iteration: 0 },
  }, startedAt + 100);

  const { lastFrame } = render(
    <SubAgentActivity activities={items} columns={80} now={startedAt + 2300} />
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Sub-agents/);
  assert.match(frame, /⠹/, 'a running child shows the spinner icon');
  assert.match(frame, /find all TODOs/);
  assert.match(frame, /1 tools/);
  assert.match(frame, /2\.3s/, 'elapsed time is shown');
});

test('sub-agent activity upsert records completion and summary', () => {
  const t0 = 1000;
  let items: SubAgentActivityItem[] = [];
  items = upsertSubAgentActivity(items, {
    subAgentId: 'sa-1',
    subAgentStatus: 'start',
    subAgentTask: 'scan repo',
  }, t0);
  items = upsertSubAgentActivity(items, {
    subAgentId: 'sa-1',
    subAgentStatus: 'done',
    subAgentTool: { tool: 'read_file', status: 'done', iteration: 2 },
  }, t0 + 500);

  assert.equal(items.length, 1, 'the child is upserted, not duplicated');
  assert.equal(items[0].status, 'done');
  assert.equal(items[0].endedAt, t0 + 500);
  assert.equal(items[0].summary, 'read_file');
  assert.equal(subAgentActivitySummary(items), '1 sub-agent: 1 done');

  const { lastFrame } = render(<SubAgentActivity activities={items} columns={80} now={t0 + 500} />);
  assert.match(lastFrame() ?? '', /✓/, 'a finished child shows the check icon');
});

test('sub-agent activity summary counts mixed statuses in one line', () => {
  const items: SubAgentActivityItem[] = [
    { id: 'a', task: 'a', status: 'done', startedAt: 0 },
    { id: 'b', task: 'b', status: 'done', startedAt: 0 },
    { id: 'c', task: 'c', status: 'error', startedAt: 0 },
  ];
  assert.equal(subAgentActivitySummary(items), '3 sub-agents: 2 done, 1 error');
});

test('sub-agent panel caps at four rows so it never hides the composer', () => {
  const many: SubAgentActivityItem[] = Array.from({ length: 8 }, (_, i) => ({
    id: `sa-${i}`,
    task: `task ${i}`,
    status: 'start' as const,
    startedAt: i,
  }));
  assert.ok(subAgentActivityRows(many) <= 4);
  const { lastFrame } = render(<SubAgentActivity activities={many} columns={80} now={5000} />);
  const frame = lastFrame() ?? '';
  assert.ok(frame.split('\n').length <= 4, `panel grew to ${frame.split('\n').length} rows`);
});

test('sub-agent activities replay from a saved session, keep the composer and persist on quit', async () => {
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-subagents-'));
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
    JSON.stringify({ animations: false, mouseClicks: false, variant: 'none', approvalMode: 'manual' })
  );

  const id = 'subact01';
  const dir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const activities: SubAgentActivityItem[] = [
    { id: 'sa-1', task: 'scan repo', status: 'done', toolCalls: 3, startedAt: 1000, endedAt: 2000 },
    { id: 'sa-2', task: 'write docs', status: 'error', toolCalls: 1, startedAt: 1000, endedAt: 1500 },
  ];
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'gpt-4o-mini',
      provider: 'openai',
      todos: [],
      completionMessages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      subAgentActivities: activities,
    })
  );

  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<App sessionId={id} />);
    const frame = await waitForFrame(
      instance.lastFrame,
      (f) => f.includes('2 sub-agents: 1 done, 1 error'),
      6000
    );
    assert.match(frame, /Build anything…/, 'composer stays visible with the replay card');

    // /quit saves the active session before exiting.
    instance.stdin.write('/quit');
    await settle(50);
    instance.stdin.write('\r');

    const file = path.join(dir, `${id}.json`);
    const deadline = Date.now() + 4000;
    let saved: any = null;
    while (Date.now() < deadline) {
      try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // not written yet
      }
      if (saved?.subAgentActivities?.length === 2) break;
      await settle(50);
    }
    assert.ok(saved, 'session file is still present after /quit');
    assert.deepEqual(
      saved.subAgentActivities,
      activities,
      'sub-agent activities persist into the saved session'
    );
  } finally {
    instance?.unmount();
    instance?.cleanup();
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
    setApprovalMode('manual');
  }
});

// ─── Zoom / resize safety ───
// ink-testing-library hard-codes 100 columns and exposes no rows, so render the
// App with a controllable stdout instead. This lets us drive real resize events
// (both Ink and App subscribe to stdout 'resize') at phone-sized dimensions.
class SizedStdout extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public cols: number, public rowCount: number) {
    super();
  }
  get columns() { return this.cols; }
  get rows() { return this.rowCount; }
  write = (chunk: string | Uint8Array): boolean => {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  /** Most recent real Ink frame (raw control writes are skipped). */
  frame(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = plain(this.frames[i] ?? '');
      if (frame.includes('┃')) return frame; // composer accent bar
    }
    return '';
  }
  /** Most recent frame containing `text` (modal prompts hide the composer). */
  frameContaining(text: string): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = plain(this.frames[i] ?? '');
      if (frame.includes(text)) return frame;
    }
    return '';
  }
}

class SizedStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    const value = this.data;
    this.data = null;
    return value;
  }
  // Mimic ink-testing-library so keys reach Ink's useInput handlers.
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
  };
}

class SizedStderr extends EventEmitter {
  frames: string[] = [];
  write = (chunk: string | Uint8Array): boolean => {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
}

function setupSizedHome() {
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-zoom-'));
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
    JSON.stringify({ animations: false, mouseClicks: false, variant: 'none', approvalMode: 'manual' })
  );
  return () => {
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
    setApprovalMode('manual');
  };
}

function renderAppSized(columns: number, rows: number) {
  const restoreHome = setupSizedHome();
  const stdout = new SizedStdout(columns, rows);
  const stdin = new SizedStdin();
  const instance = renderInk(<App />, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new SizedStderr() as any,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const resize = (cols: number, lineCount: number) => {
    stdout.cols = cols;
    stdout.rowCount = lineCount;
    stdout.emit('resize');
  };
  return {
    stdout,
    stdin,
    instance,
    resize,
    cleanup() {
      instance.unmount();
      instance.cleanup();
      restoreHome();
    },
  };
}

const lineWidth = (frame: string): number =>
  Math.max(0, ...frame.split('\n').map((line) => stripAnsi(line).length));

for (const [columns, rows] of [
  [40, 10],
  [30, 8],
  [20, 6],
  [8, 4],
  [200, 60],
] as const) {
  test(`app frame fits a ${columns}x${rows} terminal: composer + footer always present`, async () => {
    const app = renderAppSized(columns, rows);
    try {
      const frame = await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));
      assert.ok(frame.length > 0, `no real frame rendered at ${columns}x${rows}`);
      assert.match(frame, /┃/, 'composer stays visible');
      assert.match(frame, /📁|ctx/, 'footer stays visible');
      assert.ok(
        frame.split('\n').length <= rows - 1,
        `frame grew to ${frame.split('\n').length} rows on a ${rows}-row terminal`
      );
      assert.ok(
        lineWidth(frame) <= columns,
        `a line is ${lineWidth(frame)} columns wide on a ${columns}-column terminal`
      );
    } finally {
      app.cleanup();
    }
  });
}

test('rapid zoom bursts re-render at the new size without stale rows', async () => {
  const app = renderAppSized(80, 24);
  try {
    await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));

    // Shrink in a burst; the last frame must reflect the last size only.
    app.resize(20, 6);
    let frame = await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => lineWidth(f) <= 20);
    assert.ok(frame.split('\n').length <= 5, `frame is ${frame.split('\n').length} rows tall at 20x6`);

    app.resize(8, 4);
    frame = await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => lineWidth(f) <= 8);
    assert.ok(frame.split('\n').length <= 3, `frame is ${frame.split('\n').length} rows tall at 8x4`);

    // Grow again; composer must still be present and within the new bounds.
    app.resize(200, 60);
    frame = await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃') && f.split('\n').length > 20);
    assert.ok(frame.split('\n').length <= 59);
    assert.ok(lineWidth(frame) <= 200);
  } finally {
    app.cleanup();
  }
});

test('dialog stays centred and inside the frame across zoom bursts', async () => {
  const app = renderAppSized(100, 24);
  try {
    await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));
    app.stdin.write('\x1c'); // ctrl+, opens settings
    await waitForFrame(app.stdout.frameContaining.bind(app.stdout, 'Settings'), (f) => f.length > 0);

    // Every step must be a real size change: App deliberately skips no-op
    // resize events, so a same-size step would emit no new frame to wait for.
    for (const [columns, rows] of [
      [60, 16],
      [40, 10],
      [20, 6],
      [100, 24],
    ] as const) {
      const from = app.stdout.frames.length;
      app.resize(columns, rows);
      const frame = await waitForFrameWhere(
        app,
        (f) => f.includes('Settings') && f.split('\n').length <= rows && lineWidth(f) <= columns,
        5000,
        from
      );
      assert.ok(frame, `dialog survives ${columns}x${rows}`);
      assert.ok(frame.includes('Settings'), `dialog survives ${columns}x${rows}`);
      assert.ok(lineWidth(frame) <= columns, `dialog fits ${columns} columns`);
      assert.ok(frame.split('\n').length <= rows, `dialog fits ${rows} rows`);

      const border = frame.split('\n').find((line) => line.includes('╭'));
      if (border) {
        const left = border.length - border.trimStart().length;
        const expectedLeft = Math.floor((columns - border.trim().length) / 2);
        assert.ok(Math.abs(left - expectedLeft) <= 1, `dialog is centred at ${columns} columns`);
      }
    }
  } finally {
    app.cleanup();
  }
});

test('transient 0/NaN resize values keep the last valid dimensions', async () => {
  const app = renderAppSized(80, 24);
  try {
    await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));
    const from = app.stdout.frames.length;
    // A bogus resize is deliberately a no-op, so it emits no frame to wait for.
    // Follow it with a real resize and wait for that frame instead of sleeping.
    app.resize(0, Number.NaN);
    app.resize(60, 18);
    const frame = await waitForFrameWhere(
      app,
      (f) => f.includes('┃') && lineWidth(f) <= 60 && f.split('\n').length <= 17,
      5000,
      from
    );
    assert.ok(frame, 'a valid frame rendered after the bogus resize');
    assert.ok(Number.isFinite(lineWidth(frame)), 'frame width is a finite number');
    assert.ok(frame.split('\n').length <= 17, 'frame did not grow from a bogus resize');
    // Nothing painted between the two resizes may carry bogus dimensions.
    for (let i = from; i < app.stdout.frames.length; i++) {
      assert.doesNotMatch(
        plain(app.stdout.frames[i] ?? ''),
        /NaN|undefined/,
        'bogus resize leaked into a frame'
      );
    }
  } finally {
    app.cleanup();
  }
});

for (const [columns, rows] of [
  [40, 10],
  [30, 8],
  [20, 6],
] as const) {
  test(`approval dialog shows its header, all options and hint at ${columns}x${rows}`, async () => {
    const app = renderAppSized(columns, rows);
    try {
      await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));
      // Trigger the UI-owned handler; the promise is resolved by selecting below.
      void requestApproval({
        type: 'bash',
        description: 'Run a shell command',
        detail: `echo ${'x'.repeat(300)}`,
        sessionId: `approval-${columns}x${rows}`,
      } as any);
      const frame = await waitForFrame(
        app.stdout.frameContaining.bind(app.stdout, 'Approval required'),
        (f) => f.length > 0
      );
      assert.ok(frame.length > 0, 'approval dialog never rendered');
      assert.match(frame, /Approval required/, 'title is visible');
      assert.match(frame, /Run a shell|echo/, 'description/detail is visible (truncated)');
      assert.match(frame, /Approve once/, 'first option is not clipped away');
      assert.match(frame, /Approve session/, 'session option is readable on narrow screens');
      assert.match(frame, /Reject/, 'last option is not clipped away');
      assert.match(frame, /enter/, 'hint is visible');
      assert.doesNotMatch(frame, new RegExp(`x{50}`), 'detail is truncated to fit');
      assert.ok(
        frame.split('\n').length <= rows,
        `frame grew to ${frame.split('\n').length} rows on a ${rows}-row terminal`
      );
      assert.ok(
        lineWidth(frame) <= columns,
        `a line is ${lineWidth(frame)} columns wide on a ${columns}-column terminal`
      );
      // The dialog is centred on the canvas, not pinned to the composer.
      const lines = frame.split('\n');
      const titleRow = lines.findIndex((line) => line.includes('Approval required'));
      assert.ok(titleRow >= 0 && titleRow < lines.length - 3, 'dialog is not pinned to the composer');
    } finally {
      app.cleanup();
    }
  });
}

test('approving resolves once and clears the prompt', async () => {
  const app = renderAppSized(30, 8);
  let resolveCount = 0;
  try {
    await waitForFrame(app.stdout.frame.bind(app.stdout), (f) => f.includes('┃'));
    const pending = requestApproval({
      type: 'bash',
      description: 'Run a shell command',
      sessionId: 'approval-resolve-once',
    } as any).then((value) => {
      resolveCount += 1;
      return value;
    });
    await waitForFrame(app.stdout.frameContaining.bind(app.stdout, 'Approval Required'), (f) => f.length > 0);

    // Since the modal owns the keyboard, '1' selects Approve once immediately.
    const from = app.stdout.frames.length;
    app.stdin.write('1');
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('approval never resolved')), 4000)),
    ]);
    assert.equal(result, true, 'requestApproval resolves to approved');
    assert.equal(resolveCount, 1, 'the response settles exactly once');

    const cleared = await waitForFrameWhere(
      app,
      (f) => f.includes('┃') && !f.includes('Approval Required'),
      4000,
      from
    );
    assert.match(cleared, /Build anything…/, 'the composer is back after approval');
    assert.doesNotMatch(cleared, /Approval Required/, 'the prompt is gone');
  } finally {
    app.cleanup();
  }
});

test('approval prompt settles only once when number keys and Enter collide', async () => {
  let responses = 0;
  const { stdin, stdout } = render(
    <ApprovalPrompt
      request={{ type: 'bash', description: 'Run a shell command' } as any}
      columns={40}
      rows={10}
      onRespond={() => { responses += 1; }}
    />
  );
  await waitFor(
    () => stdout.frames.some((f) => f.includes('1. Approve once')),
    2000,
    'approval options did not render'
  );
  stdin.write('1');
  await waitFor(() => responses === 1, 2000, 'digit key did not settle the prompt');

  // Enter repaints the Select highlight, so wait for that frame rather than a
  // fixed sleep; the trailing digit produces no repaint, just flush its handler.
  const from = stdout.frames.length;
  stdin.write('\r');
  await waitFor(() => stdout.frames.length > from, 2000, 'enter key was not processed');
  stdin.write('2');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses, 1, 'onRespond is called once for the whole interaction');
});

test('critical prompts stay inside a narrow terminal', () => {
  for (const columns of [8, 20, 30, 40]) {
    const ask = render(
      <Box width={columns}>
        <AskPrompt
          columns={columns}
          questions={[{
            id: 'q',
            question: 'Which approach should I take?',
            context: 'Both work; one is simpler and faster.',
            options: [
              { label: 'Rewrite everything from scratch', recommended: true },
              { label: 'Apply a small targeted patch' },
            ],
          }]}
          onRespond={() => {}}
        />
      </Box>
    );
    const askFrame = ask.lastFrame() ?? '';
    assert.ok(
      lineWidth(askFrame) <= columns,
      `ask prompt is ${lineWidth(askFrame)} wide at ${columns} columns`
    );
    ask.unmount();
    ask.cleanup();

    const approval = render(
      <Box width={columns}>
        <ApprovalPrompt
          columns={columns}
          request={{
            type: 'bash',
            description: 'Run a very long shell command description here',
            detail: 'x'.repeat(400),
          } as any}
          onRespond={() => {}}
        />
      </Box>
    );
    const approvalFrame = approval.lastFrame() ?? '';
    assert.ok(
      lineWidth(approvalFrame) <= columns,
      `approval prompt is ${lineWidth(approvalFrame)} wide at ${columns} columns`
    );
    approval.unmount();
    approval.cleanup();

    const key = render(
      <Box width={columns}>
        <ApiKeyPrompt
          columns={columns}
          providerName="OpenAI"
          path="/a/very/long/path/to/the/configuration/file.jsonc"
          error={null}
          busy={false}
          onSubmit={() => {}}
        />
      </Box>
    );
    const keyFrame = key.lastFrame() ?? '';
    assert.ok(
      lineWidth(keyFrame) <= columns,
      `API key prompt is ${lineWidth(keyFrame)} wide at ${columns} columns`
    );
    key.unmount();
    key.cleanup();
  }
});

test('ask prompt keeps option labels and the recommended marker visible on narrow screens', () => {
  for (const columns of [20, 30, 40]) {
    const ask = render(
      <Box width={columns}>
        <AskPrompt
          columns={columns}
          compact
          questions={[{
            id: 'q',
            question: 'Which approach?',
            options: [
              { label: 'Rewrite everything from scratch', recommended: true },
              { label: 'Apply a small targeted patch' },
            ],
          }]}
          onRespond={() => {}}
        />
      </Box>
    );
    const frame = plain(ask.lastFrame() ?? '');
    assert.ok(lineWidth(frame) <= columns, `ask prompt overflows at ${columns} columns`);
    assert.ok(frame.includes('Rewri'), `first option label is clipped away at ${columns} columns`);
    assert.ok(frame.includes('Apply'), `second option label is clipped away at ${columns} columns`);
    assert.ok(/★|recommended/.test(frame), `recommended marker is missing at ${columns} columns`);
    ask.unmount();
    ask.cleanup();
  }
});

const CONFIG_KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'BITACODE_API_KEY',
];

test('first run auto-detects a provider from env and skips the setup wizard', async () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalKeys = new Map(CONFIG_KEY_ENV_VARS.map((key) => [key, process.env[key]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-env-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-env-cwd-'));

  process.env.HOME = home;
  process.chdir(cwd);
  for (const key of CONFIG_KEY_ENV_VARS) delete process.env[key];
  process.env.OPENAI_API_KEY = 'env-detected-key';
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'settings.json'),
    JSON.stringify({ animations: false, mouseClicks: false, variant: 'none', approvalMode: 'manual' })
  );
  resetRuntimeConfigForTests();

  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<App />);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes('Build anything…'));
    assert.match(frame, /Build anything…/);
    assert.doesNotMatch(frame, /Welcome to Bitacode/);
    assert.doesNotMatch(frame, /Select an AI Model/);

    const detected = readConfig('user');
    const openai = getAllProviders().find((provider) => provider.id === 'openai')!;
    assert.equal(detected?.provider, 'openai');
    assert.equal(detected?.model, openai.models[0].id);
  } finally {
    instance?.unmount();
    instance?.cleanup();
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    for (const key of CONFIG_KEY_ENV_VARS) {
      const original = originalKeys.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    resetRuntimeConfigForTests();
    setApprovalMode('manual');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ─── New UI features (plan mode, retry, shell, search, collapse, images) ───
test('tab toggles the PLAN MODE badge without stealing composer focus', async () => {
  const app = renderApp();
  try {
    const idle = await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    assert.doesNotMatch(idle, /PLAN MODE/);
    await settle(150); // let Ink finish wiring stdin after the first ready frame

    const plan = await pressUntil(app, '\t', (f) => f.includes('PLAN MODE')); // Tab
    assert.match(plan, /PLAN MODE/);
    assert.match(plan, /Build anything…/, 'the composer stays visible in plan mode');

    const build = await pressUntil(app, '\t', (f) => !f.includes('PLAN MODE'));
    assert.ok(build, 'Tab toggles back to build mode');
    assert.doesNotMatch(build, /PLAN MODE/);
  } finally {
    app.cleanupAll();
  }
});

test('ctrl+r retries the last submitted text and refills the composer', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    await settle(150);
    await typeSubmit(app, 'RETRY-MARKER'); // starts a run that the retry aborts
    await settle(80);

    const frame = await pressUntil(app, '\x12', (f) => f.includes('Retrying: RETRY-MARKER'));
    assert.match(frame, /RETRY-MARKER/, 'the last message is retried/refilled');
    assert.match(frame, /Retrying:/, 'a brief retry hint is shown');
  } finally {
    app.cleanupAll();
  }
});

test('! <cmd> runs bash directly and shows the result in the transcript', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    await settle(150);
    await typeSubmit(app, '! echo SHELL-MARKER');

    const frame = await waitForFrameText(app, 'SHELL-MARKER', 5000);
    assert.match(frame, /echo SHELL-MARKER/, 'the shell command card is shown');
    assert.match(frame, /SHELL-MARKER/, 'the command output is shown');
  } finally {
    app.cleanupAll();
  }
});

test('/update is listed in the slash palette and help', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    await settle(400);
    app.stdin.write('/up');
    const frame = await waitForFrameText(app, '/update', 2000);
    assert.match(frame, /Update Bitacode from npm/, 'slash palette advertises the npm update');
  } finally {
    app.cleanupAll();
  }
});

test('/find filters the transcript and shows a match count', async () => {
  const app = renderApp({ sessionId: 'find0001' }, (home) =>
    seedSession(home, 'find0001', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'FINDME-MARKER' },
      { role: 'assistant', content: 'unrelated answer' },
    ])
  );
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('FINDME-MARKER'));
    await settle(150);
    await typeSubmit(app, '/find FINDME');

    const frame = await waitForFrameText(app, 'match', 5000);
    assert.match(frame, /1 match for "FINDME"/, 'exactly one match is reported');
    assert.match(frame, /FINDME-MARKER/, 'the matching card stays visible');
    assert.doesNotMatch(frame, /unrelated answer/, 'non-matching cards are filtered out');
  } finally {
    app.cleanupAll();
  }
});

test('ctrl+e collapses and expands all transcript cards', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `COLLAPSE-LINE-${i}`);
  const app = renderApp({ sessionId: 'collapse' }, (home) =>
    seedSession(home, 'collapse', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer', reasoning: lines.join('\n') },
    ])
  );
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('COLLAPSE-LINE-0'));
    assert.doesNotMatch(app.lastFrame() ?? '', /COLLAPSE-LINE-9/, 'card starts collapsed');
    await settle(150);

    const expanded = await pressUntil(app, '\x05', (f) => f.includes('COLLAPSE-LINE-9')); // Ctrl+E
    assert.match(expanded, /COLLAPSE-LINE-9/, 'all cards expand');

    const collapsed = await pressUntil(app, '\x05', (f) => !f.includes('COLLAPSE-LINE-9'));
    assert.ok(collapsed, 'all cards collapse again');
    assert.doesNotMatch(collapsed, /COLLAPSE-LINE-9/);
  } finally {
    app.cleanupAll();
  }
});

test('/image with a fake path shows a clear error', async () => {
  const app = renderApp();
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    await settle(150);
    await typeSubmit(app, '/image /no/such/photo.png');

    const frame = await waitForFrameText(app, 'Image error', 5000);
    assert.match(frame, /Image error/);
    assert.match(frame, /\/no\/such\/photo\.png/, 'the bad path is named in the error');
  } finally {
    app.cleanupAll();
  }
});

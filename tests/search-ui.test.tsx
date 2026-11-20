import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { WebSearchView } from '../src/components/WebSearchView.js';
import { parseWebSearchResult, formatWebSearchResult } from '../src/utils/web-search-result.js';
import { PromptInput } from '../src/components/PromptInput.js';
import type { MentionCollectionResult } from '../src/utils/mention-candidates.js';
import { settle } from './helpers/wait.js';

test('search card shows only URL, text and related queries', async () => {
  const raw = formatWebSearchResult({
    queries: ['ink cli'],
    blocks: [{
      query: 'ink cli',
      resources: [{ url: 'https://example.com/ink', text: 'A React renderer for terminals.' }],
    }],
    related: ['ink cli examples'],
    errors: [],
  });
  const payload = parseWebSearchResult(raw)!;
  assert.ok(payload, 'payload parses');
  const view = render(
    <ThemeProvider name="black">
      <WebSearchView payload={payload} />
    </ThemeProvider>
  );
  await settle(30);
  const text = stripAnsi(view.lastFrame() ?? '');
  assert.match(text, /Web search/);
  assert.match(text, /https:\/\/example\.com\/ink/);
  assert.match(text, /A React renderer for terminals/);
  assert.match(text, /ink cli examples/);
  // The transport format itself must never leak into the human-facing card.
  assert.doesNotMatch(text, /WEB_SEARCH|QUERY:|RESOURCE:|TEXT:/);
  view.unmount();
});

test('@ popup inserts the selected relative path on Enter and never submits', async () => {
  const candidates: MentionCollectionResult = {
    candidates: [
      { id: 'file:src/App.tsx', label: 'src/App.tsx', kind: 'file', detail: 'File' },
      { id: 'skill:reviewer', label: 'reviewer', kind: 'skill', detail: 'audit', source: 'user' },
    ],
  };
  let submitted: string | null = null;
  const Harness: React.FC = () => {
    const [value, setValue] = React.useState('@');
    return (
      <ThemeProvider name="black">
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={(next) => { submitted = next; }}
          width={60}
          onMentionCandidates={async () => candidates}
        />
      </ThemeProvider>
    );
  };
  const view = render(<Harness />);
  await settle(60);
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /Reference/);
  assert.match(frame, /src\/App\.tsx/);
  assert.match(frame, /reviewer/);

  view.stdin.write('\r');
  await settle(60);
  assert.equal(submitted, null, 'Enter in the popup must not submit the prompt');
  assert.match(stripAnsi(view.lastFrame() ?? ''), /src\/App\.tsx/, 'the path is inserted into the composer');
  view.unmount();
});

test('@ popup can select a skill and dismisses on Escape', async () => {
  const candidates: MentionCollectionResult = {
    candidates: [{ id: 'skill:reviewer', label: 'reviewer', kind: 'skill', detail: 'audit', source: 'project' }],
  };
  let submitted: string | null = null;
  const Harness: React.FC = () => {
    const [value, setValue] = React.useState('@');
    return (
      <ThemeProvider name="black">
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={(next) => { submitted = next; }}
          width={60}
          onMentionCandidates={async () => candidates}
        />
      </ThemeProvider>
    );
  };
  const view = render(<Harness />);
  await settle(60);
  assert.match(stripAnsi(view.lastFrame() ?? ''), /project · audit/);

  view.stdin.write('\x1b[B'); // down
  await settle(30);
  view.stdin.write('\r');
  await settle(60);
  assert.equal(submitted, null);
  assert.match(stripAnsi(view.lastFrame() ?? ''), /reviewer/);

  // A fresh @ with an error provider still renders the inline error line.
  const errorHarness = render(
    <ThemeProvider name="black">
      <PromptInput
        value="@bad"
        onChange={() => {}}
        onSubmit={() => {}}
        width={60}
        onMentionCandidates={async () => ({ candidates: [], error: 'disk unavailable' })}
      />
    </ThemeProvider>
  );
  await settle(60);
  assert.match(stripAnsi(errorHarness.lastFrame() ?? ''), /disk unavailable/);
  errorHarness.unmount();
  view.unmount();
});

test('@ popup titles mixed skill and file candidates with skills first', async () => {
  const candidates: MentionCollectionResult = {
    candidates: [
      { id: 'skill:reviewer', label: 'reviewer', kind: 'skill', detail: 'Review code changes', source: 'user' },
      { id: 'skill:releaser', label: 'releaser', kind: 'skill', detail: 'Prepare releases', source: 'project' },
      { id: 'file:src/App.tsx', label: 'src/App.tsx', kind: 'file', detail: 'File' },
    ],
  };
  let submitted: string | null = null;
  const Harness: React.FC = () => {
    const [value, setValue] = React.useState('@');
    return (
      <ThemeProvider name="black">
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={(next) => { submitted = next; }}
          width={60}
          onMentionCandidates={async () => candidates}
        />
      </ThemeProvider>
    );
  };
  const view = render(<Harness />);
  await settle(60);
  const frame = stripAnsi(view.lastFrame() ?? '');

  assert.match(frame, /Skills/, 'skills group has a heading');
  assert.match(frame, /Files/, 'files group has a heading');
  assert.match(frame, /reviewer/, 'skill label is visible');
  assert.match(frame, /user · Review code changes/, 'skill source and description are visible');
  assert.match(frame, /src\/App\.tsx/, 'file relative path is visible');

  const skillsAt = frame.indexOf('Skills');
  const filesAt = frame.indexOf('Files');
  assert.ok(skillsAt >= 0 && filesAt >= 0);
  assert.ok(skillsAt < filesAt, 'the Skills heading and skill rows come before the Files heading');

  view.stdin.write('\r');
  await settle(60);
  assert.equal(submitted, null, 'Enter in the popup must not submit the prompt');
  assert.match(stripAnsi(view.lastFrame() ?? ''), /reviewer/, 'the highlighted skill is inserted');
  view.unmount();
});

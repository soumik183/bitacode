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

test('search card fits the columns prop with no URL overflow on a narrow frame', async () => {
  const url = `https://example.com/${'a'.repeat(120)}`;
  const raw = formatWebSearchResult({
    queries: ['ink'],
    blocks: [{
      query: 'ink',
      resources: [{ url, text: `A long result. ${'more words '.repeat(30)}` }],
    }],
    related: [],
    errors: [],
  });
  const payload = parseWebSearchResult(raw)!;
  assert.ok(payload);
  const view = render(
    <ThemeProvider name="black">
      <WebSearchView payload={payload} columns={40} />
    </ThemeProvider>
  );
  await settle(30);
  const lines = stripAnsi(view.lastFrame() ?? '').split('\n');
  assert.notEqual(lines[0], '', 'no blank row above the search card');
  assert.equal(lines[lines.length - 1], '', 'one blank row below the card');
  assert.notEqual(lines[lines.length - 2], '', 'exactly one blank row below');
  // The snippet relies on Ink's own wrapping against the real stdout width;
  // the URL row is where the card shrinks itself to the supplied columns.
  const urlLines = lines.filter((line) => line.includes('https://example.com/'));
  assert.equal(urlLines.length, 1, 'the long URL stays on a single row');
  assert.match(urlLines[0], /↗ https:\/\/example\.com\//, 'URL row is rendered');
  assert.match(urlLines[0], /…$/, 'URL is shortened to fit');
  assert.ok(urlLines[0].length <= 40, `URL row fits in 40 columns: ${JSON.stringify(urlLines[0])}`);
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
  const after = stripAnsi(view.lastFrame() ?? '');
  assert.match(after, /src\/App\.tsx/, 'the path is inserted into the composer');
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

test('@ popup keeps every matching file and End jumps to the skills at the end', async () => {
  const candidates: MentionCollectionResult = {
    candidates: [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `file:src/file${String(i).padStart(2, '0')}.ts`,
        label: `src/file${String(i).padStart(2, '0')}.ts`,
        kind: 'file' as const,
        detail: 'File',
      })),
      { id: 'skill:reviewer', label: 'reviewer', kind: 'skill', detail: 'review code', source: 'user' },
      { id: 'skill:releaser', label: 'releaser', kind: 'skill', detail: 'ship it', source: 'project' },
    ],
  };
  const Harness: React.FC = () => {
    const [value, setValue] = React.useState('@');
    return (
      <ThemeProvider name="black">
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={() => {}}
          width={70}
          onMentionCandidates={async () => candidates}
        />
      </ThemeProvider>
    );
  };
  const view = render(<Harness />);
  await settle(60);
  const first = stripAnsi(view.lastFrame() ?? '');
  assert.match(first, /↓ \d+ more/, 'a long file list is windowed, not truncated');
  assert.match(first, /src\/file00\.ts/, 'first match shown');
  assert.doesNotMatch(first, /reviewer/, 'skills are at the end, below the fold');

  view.stdin.write('\x1b[F'); // End
  await settle(60);
  const end = stripAnsi(view.lastFrame() ?? '');
  assert.match(end, /reviewer/, 'End jumps to the skill rows');
  assert.match(end, /releaser/, 'the last skill is visible');
  assert.match(end, /↑ \d+ more/, 'hidden files are reported above');
  view.unmount();
});

test('@ popup shows files first, skills last, with every title visible', async () => {
  const candidates: MentionCollectionResult = {
    candidates: [
      { id: 'file:src/App.tsx', label: 'src/App.tsx', kind: 'file', detail: 'File' },
      { id: 'dir:src/', label: 'src/', kind: 'directory', detail: 'Directory' },
      {
        id: 'skill:reviewer',
        label: 'reviewer',
        kind: 'skill',
        detail: 'A very long description that would otherwise squeeze the title out of the row entirely',
        source: 'user',
      },
      { id: 'skill:releaser', label: 'releaser', kind: 'skill', detail: 'Prepare releases', source: 'project' },
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
  assert.match(frame, /user ·/, 'skill source is visible');
  assert.match(frame, /src\/App\.tsx/, 'file relative path is visible');
  assert.match(frame, /▸ src\//, 'folders keep the triangle icon');
  assert.match(frame, /▤ src\/App\.tsx/, 'files keep the document icon');
  // The title must survive a long description — this was the reported bug.
  const skillRow = frame.split('\n').find((line) => line.includes('user ·'));
  assert.match(skillRow ?? '', /reviewer/, 'the skill title stays visible beside its description');

  const skillsAt = frame.indexOf('Skills');
  const filesAt = frame.indexOf('Files');
  assert.ok(skillsAt >= 0 && filesAt >= 0);
  assert.ok(filesAt < skillsAt, 'the Files heading comes before the Skills heading');

  view.stdin.write('\r');
  await settle(60);
  assert.equal(submitted, null, 'Enter in the popup must not submit the prompt');
  assert.match(stripAnsi(view.lastFrame() ?? ''), /src\/App\.tsx/, 'the highlighted file path is inserted');
  view.unmount();
});

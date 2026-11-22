import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DiffView, DIFF_PREVIEW_LINES } from '../src/components/DiffView.js';

const plain = (frame: string | undefined): string => stripAnsi(frame ?? '');
const renderText = (node: React.ReactElement): string => plain(render(node).lastFrame());

test('multi-file entries render a per-file header and share aligned gutters', () => {
  const entries = [
    { filePath: 'src/a.ts', header: 'Edited src/a.ts', diff: '@@ -1 +1 @@\n-oldA\n+newA' },
    { filePath: 'src/b.ts', header: 'Edited src/b.ts', diff: '@@ -1 +1 @@\n-oldB\n+newB' },
  ];
  const frame = renderText(<DiffView header="Edited 2 files" diff="" entries={entries} />);

  assert.match(frame, /▸ src\/a\.ts/);
  assert.match(frame, /▸ src\/b\.ts/);
  assert.match(frame, /\+ newA/);
  assert.match(frame, /\+ newB/);
  assert.match(frame, /- oldA/);
  assert.match(frame, /- oldB/);
  // The header carries every path and the combined +N -M counts.
  assert.match(frame, /Edited 2 files {2}src\/a\.ts, src\/b\.ts/);
  assert.match(frame, /\+2/);
  assert.match(frame, /-2/);

  const ruleColumn = (line: string): number => {
    const left = line.indexOf('│');
    return line.indexOf('│', left + 1);
  };
  const rules = new Set(
    frame
      .split('\n')
      .filter((line) => {
        const first = line.indexOf('│');
        const second = line.indexOf('│', first + 1);
        return second !== -1 && line.indexOf('│', second + 1) !== -1;
      })
      .map(ruleColumn)
  );
  assert.equal(rules.size, 1, 'all files share one gutter width and side-rule column');
});

test('a diff longer than 24 lines renders in full with no toggle', () => {
  const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n');
  const frame = renderText(<DiffView header="Wrote big.txt" diff={diff} operation="Wrote" />);

  assert.match(frame, /line 39/, 'the last line is present, not clipped at 24');
  assert.doesNotMatch(frame, /more lines|diff truncated|click to/);
  assert.ok(DIFF_PREVIEW_LINES > 24, 'the public ceiling is now generous');
});

test('an empty diff shows a clean note instead of a bare header', () => {
  const frame = renderText(<DiffView header="Edited empty.ts" diff="" />);
  assert.match(frame, /No textual changes\./);
  assert.doesNotMatch(frame, /more lines|diff truncated/);
});

test('an explicit maxRows stays a hard cap and reports truncation', () => {
  const diff = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
  const frame = renderText(<DiffView header="Streaming diff" diff={diff} maxRows={3} />);

  assert.match(frame, /line 2/);
  assert.doesNotMatch(frame, /line 3/);
  assert.match(frame, /diff truncated/);
  assert.doesNotMatch(frame, /click to/, 'a live preview has no toggle');
});

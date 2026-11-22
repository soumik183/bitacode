import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { UsageDisplay } from '../src/components/UsageDisplay.js';
import { formatTokenCount } from '../src/utils/cost-tracker.js';

const base = {
  usage: { inputTokens: 365100, outputTokens: 1000, cost: 0.02, contextPercent: 35 },
  totalCost: 0.02,
  modelLabel: 'OpenAI / gpt-4o',
  variantLabel: 'none',
  variantColor: '#fff',
  folder: 'cli',
  branch: 'main',
  busy: false,
  tool: null,
  frame: 0,
  compact: false,
  gutter: 1,
  dense: false,
  segments: ['folder', 'model', 'context'] as const,
};

test('formatTokenCount uses K/M with one decimal', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0K');
  assert.equal(formatTokenCount(365100), '365.1K');
  assert.equal(formatTokenCount(1_250_000), '1.3M');
  assert.equal(formatTokenCount(undefined), '0');
});

test('footer shows used tokens and the percentage from the real window', () => {
  const view = render(
    <UsageDisplay
      {...base}
      segments={[...base.segments]}
      contextTokens={365_100}
      contextWindow={1_048_576}
    />
  );
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /365\.1K \(35%\)/, 'used tokens and percentage are shown together');
  view.unmount();
});

test('unknown model falls back to the precomputed percentage', () => {
  const view = render(<UsageDisplay {...base} segments={[...base.segments]} />);
  const frame = stripAnsi(view.lastFrame() ?? '');
  assert.match(frame, /35%/, 'percentage-only fallback still works');
  assert.doesNotMatch(frame, /K \(/, 'no token count without a real window');
  view.unmount();
});

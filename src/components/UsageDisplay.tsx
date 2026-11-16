import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface UsageDisplayProps {
  usage: { inputTokens: number; outputTokens: number; cost: number; contextPercent: number } | null;
  totalCost: number;
  modelLabel: string;
  variantLabel: string;
  variantColor: string;
  folder: string;
  busy: boolean;
  tool: string | null;
  frame: number;
  /** Narrow terminals drop the variant/cost cluster so the row never overflows. */
  compact?: boolean;
  gutter?: number;
}

// Bouncing equaliser: shifts one bar per frame so it reads as AI activity.
const WAVE = '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁';
const WAVE_WIDTH = 10;
const LEVELS = '▁▂▃▄▅▆▇█';
// Dark → bright blue, so taller bars glow more.
const LEVEL_COLORS = [
  '#1e3a8a',
  '#1d4ed8',
  '#2563eb',
  '#3b82f6',
  '#60a5fa',
  '#93c5fd',
  '#bfdbfe',
  '#e0f2fe',
];

function wave(frame: number): string {
  const start = frame % WAVE.length;
  return (WAVE + WAVE).slice(start, start + WAVE_WIDTH);
}

/** A moving highlight sweeps across the label, like a thinking indicator. */
const Shimmer: React.FC<{ text: string; frame: number }> = ({ text, frame }) => {
  const span = text.length + 8;
  const head = frame % span;
  return (
    <>
      {[...text].map((char, index) => {
        const distance = Math.abs(index - (head - 4));
        const color = distance <= 1 ? theme.text : distance <= 3 ? theme.muted : theme.dim;
        return (
          <Text key={index} color={color}>
            {char}
          </Text>
        );
      })}
    </>
  );
};

/**
 * Footer under the prompt: folder on the left — swapped for a live activity
 * wave while the agent works — and model · variant · context on the right.
 */
export const UsageDisplay: React.FC<UsageDisplayProps> = ({
  usage,
  totalCost,
  modelLabel,
  variantLabel,
  variantColor,
  folder,
  busy,
  tool,
  frame,
  compact = false,
  gutter = 2,
}) => {
  const context = usage ? `${usage.contextPercent.toFixed(0)}%` : '0%';

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={gutter} marginBottom={1} flexShrink={0}>
      <Box flexShrink={1} flexDirection="row">
        {busy ? (
          <>
            {wave(frame)
              .split('')
              .map((bar, index) => (
                <Text key={index} color={LEVEL_COLORS[LEVELS.indexOf(bar)]} bold>
                  {bar}
                </Text>
              ))}
            {tool && (
              <>
                <Text>{'  '}</Text>
                <Shimmer text={`running ${tool}`} frame={frame} />
              </>
            )}
          </>
        ) : (
          <Text color={theme.dim} wrap="truncate-end">
            {`📁 ${folder}`}
          </Text>
        )}
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{modelLabel}</Text>
          {!compact && (
            <>
              <Text color={theme.dim}> · </Text>
              <Text color={variantColor}>{variantLabel}</Text>
            </>
          )}
          <Text color={theme.dim}> · ctx {context}</Text>
          {!compact && totalCost > 0 && <Text color={theme.dim}> · ${totalCost.toFixed(2)}</Text>}
        </Text>
      </Box>
    </Box>
  );
};

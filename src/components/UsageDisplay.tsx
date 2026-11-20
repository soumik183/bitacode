import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_LINE_ITEMS, type StatusLineItem } from '../settings.js';

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
  /** Short terminals drop the bottom margin so the footer always fits. */
  dense?: boolean;
  /** Which status segments to show; defaults to all. */
  segments?: readonly StatusLineItem[];
  /** Live decode rate while text streams, e.g. "42 tok/s". */
  tps?: string | null;
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
  const theme = useTheme();
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
  dense = false,
  segments = STATUS_LINE_ITEMS,
  tps = null,
}) => {
  const theme = useTheme();
  const context = usage ? `${usage.contextPercent.toFixed(0)}%` : '0%';
  const show = (segment: StatusLineItem) => segments.includes(segment);
  // One combined row per side keeps the footer a single line; a segment is
  // joined only when it is enabled so hidden items leave no stray separators.
  const rightParts: React.ReactNode[] = [];
  if (show('model')) rightParts.push(<Text key="model" color={theme.muted}>{modelLabel}</Text>);
  if (!compact && show('variant')) {
    rightParts.push(<Text key="variant-sep" color={theme.dim}> · </Text>);
    rightParts.push(<Text key="variant" color={variantColor}>{variantLabel}</Text>);
  }
  if (show('context')) {
    if (rightParts.length > 0) rightParts.push(<Text key="ctx-sep" color={theme.dim}> · </Text>);
    rightParts.push(<Text key="ctx" color={theme.dim}>{`ctx ${context}`}</Text>);
  }
  if (!compact && show('cost') && totalCost > 0) {
    rightParts.push(<Text key="cost" color={theme.dim}>{` · $${totalCost.toFixed(2)}`}</Text>);
  }

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={gutter} marginBottom={dense ? 0 : 1} flexShrink={0}>
      <Box flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row">
        {show('tool') && busy ? (
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
            {!tool && tps && (
              <>
                <Text>{'  '}</Text>
                <Text color={theme.muted}>{tps}</Text>
              </>
            )}
          </>
        ) : show('folder') ? (
          <Text color={theme.dim} wrap="truncate-end">
            {`📁 ${folder}`}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{rightParts}</Text>
      </Box>
    </Box>
  );
};

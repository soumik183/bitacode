import React from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../theme.js';
import { formatTokenCount } from '../utils/cost-tracker.js';
import { STATUS_LINE_ITEMS, type StatusLineItem } from '../settings.js';

export interface UsageDisplayProps {
  usage: { inputTokens: number; outputTokens: number; cost: number; contextPercent: number } | null;
  totalCost: number;
  modelLabel: string;
  variantLabel: string;
  variantColor: string;
  folder: string;
  /** Current git branch, appended as `~/folder:branch` when available. */
  branch?: string | null;
  /** Estimated conversation tokens against the active context window. */
  contextTokens?: number;
  /** Real context window of the active provider/model. */
  contextWindow?: number;
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
/** Blend two theme colours; falls back to the nearer slot for named colours. */
function mixColor(from: string, to: string, t: number): string {
  const parse = (color: string): [number, number, number] | null => {
    const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color ?? '').trim());
    if (!match) return null;
    const hex = match[1].length === 3
      ? match[1].split('').map((ch) => ch + ch).join('')
      : match[1];
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return t < 0.5 ? from : to;
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Low → high bars ramp from the theme's info slot to its accent slot. */
function levelColors(theme: Theme): string[] {
  return Array.from({ length: LEVELS.length }, (_, index) =>
    mixColor(theme.info, theme.accent, index / Math.max(1, LEVELS.length - 1))
  );
}

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
  branch,
  contextTokens,
  contextWindow,
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
  const bars = levelColors(theme);
  // Prefer the real window + token count so the number and percentage always
  // agree; older events only carry a precomputed percentage, so fall back to it.
  const windowSize = contextWindow ?? 0;
  const usedTokens = contextTokens ?? 0;
  const context = windowSize > 0 && usage
    ? `${formatTokenCount(usedTokens)} (${Math.min(100, (usedTokens / windowSize) * 100).toFixed(0)}%)`
    : usage
      ? `${usage.contextPercent.toFixed(0)}%`
      : '0%';
  const show = (segment: StatusLineItem) => segments.includes(segment);
  // One combined row per side keeps the footer a single line; a segment is
  // joined only when it is enabled so hidden items leave no stray separators.
  const rightParts: React.ReactNode[] = [];
  if (show('model')) {
    // "Provider / Model": dim the provider, brighten the model. This reads as a
    // hierarchy instead of one flat grey string.
    const split = modelLabel.indexOf(' / ');
    if (split > 0) {
      rightParts.push(
        <Text key="model">
          <Text color={theme.dim}>{modelLabel.slice(0, split)}</Text>
          <Text color={theme.border}>{' / '}</Text>
          <Text color={theme.text}>{modelLabel.slice(split + 3)}</Text>
        </Text>
      );
    } else {
      rightParts.push(<Text key="model" color={theme.muted}>{modelLabel}</Text>);
    }
  }
  if (!compact && show('variant')) {
    rightParts.push(<Text key="variant-sep" color={theme.dim}> · </Text>);
    rightParts.push(<Text key="variant" color={variantColor}>{variantLabel}</Text>);
  }
  if (show('context')) {
    if (rightParts.length > 0) rightParts.push(<Text key="ctx-sep" color={theme.dim}> · </Text>);
    rightParts.push(<Text key="ctx" color={theme.dim}>{context}</Text>);
  }
  if (!compact && show('cost') && totalCost > 0) {
    rightParts.push(
      <Text key="cost" color={theme.dim}>
        {rightParts.length > 0 ? ` · $${totalCost.toFixed(2)}` : `$${totalCost.toFixed(2)}`}
      </Text>
    );
  }

  return (
    <Box
      flexDirection="row"
      width="100%"
      backgroundColor={theme.bg}
      justifyContent="space-between"
      paddingX={gutter}
      marginBottom={dense ? 0 : 1}
      flexShrink={0}
    >
      <Box flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row">
        {show('tool') && busy ? (
          <>
            {wave(frame)
              .split('')
              .map((bar, index) => (
                <Text key={index} color={bars[LEVELS.indexOf(bar)] ?? theme.accent} bold>
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
          <Text wrap="truncate-end">
            <Text color={theme.info}>{'~/'}</Text>
            <Text color={theme.muted}>{folder}</Text>
            {branch ? <Text color={theme.accent}>{`:${branch}`}</Text> : null}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{rightParts}</Text>
      </Box>
    </Box>
  );
};

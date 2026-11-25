/**
 * WebSearchView — clean result card for `web_search`.
 *
 * Shows only the resource URL, its text snippet and related queries. The raw
 * tool payload is deliberately never rendered: it is a transport format for
 * the model, not something a human should read in the transcript.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { displayWidth } from '../utils/format-message.js';
import { LeftBar } from './LeftBar.js';
import {
  parseWebSearchResult,
  type WebSearchPayload,
  type WebSearchResource,
} from '../utils/web-search-result.js';

export interface WebSearchViewProps {
  payload: WebSearchPayload;
  /** Maximum number of URLs rendered (the tool itself caps at 8 per query). */
  maxResources?: number;
  /** Terminal columns, supplied by the caller so narrow/zoomed frames fit. */
  columns?: number;
}

// The bar, its margin and the card padding take 4 columns; reserve a little
// more slack so a zoomed-in frame never wraps a URL onto the next row.
function contentWidth(columns?: number): number {
  return Math.max(1, (columns ?? 80) - 8);
}

/** Cut to a display-column budget so wide CJK/emoji cannot wrap the card. */
function clipToWidth(text: string, width: number): string {
  const limit = Math.max(1, Math.floor(width));
  if (displayWidth(text) <= limit) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > limit) break;
    used += w;
    out += ch;
  }
  return out;
}

function shorten(url: string, width: number): string {
  if (displayWidth(url) <= width) return url;
  const keep = Math.max(1, width - 1);
  return `${clipToWidth(url, keep)}…`;
}

/** Snippets follow the frame width instead of a fixed 170-character cut. */
function snippet(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const budget = Math.max(1, Math.floor(width) - 3); // indent for the snippet
  if (displayWidth(one) <= budget) return one;
  return `${clipToWidth(one, Math.max(1, budget - 1))}…`;
}

const ResourceRow: React.FC<{ resource: WebSearchResource; width: number; color: string }> = ({ resource, width, color }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={color} wrap="truncate-end">
        {`↗ ${shorten(resource.url, width)}`}
      </Text>
      {resource.text ? (
        <Text color={theme.muted} wrap="truncate-end">{`   ${snippet(resource.text, width)}`}</Text>
      ) : null}
    </Box>
  );
};

export const WebSearchView: React.FC<WebSearchViewProps> = ({ payload, maxResources = 24, columns }) => {
  const theme = useTheme();
  const width = contentWidth(columns);
  const resources = payload.blocks.flatMap((block) => block.resources).slice(0, maxResources);
  const queryLabel = payload.queries.length === 1 ? payload.queries[0] : `${payload.queries.length} queries`;

  return (
    <Box paddingX={2} marginBottom={1}>
      <LeftBar color={theme.info}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            <Text color={theme.accent}>{'⌕ Web search'}</Text>
            <Text color={theme.dim}>{`  ${queryLabel}`}</Text>
            <Text color={theme.dim}>{` · ${resources.length} resource${resources.length === 1 ? '' : 's'}`}</Text>
          </Text>

          {resources.map((resource, index) => (
            <ResourceRow key={`${resource.url}-${index}`} resource={resource} width={width} color={theme.info} />
          ))}

          {payload.blocks.some((block) => block.error) ? (
            <Box flexDirection="column">
              {payload.blocks
                .filter((block) => block.error)
                .map((block, index) => (
                  <Text key={`err-${index}`} color={theme.error} wrap="truncate-end">
                    {`✗ ${block.query}: ${block.error}`}
                  </Text>
                ))}
            </Box>
          ) : null}

          {payload.related.length > 0 ? (
            <Text wrap="truncate-end">
              <Text color={theme.dim}>{'Related: '}</Text>
              {payload.related.map((item, index) => (
                <Text key={`rel-${index}`}>
                  {index > 0 ? <Text color={theme.dim}>{' · '}</Text> : null}
                  <Text color={theme.info}>{item}</Text>
                </Text>
              ))}
            </Text>
          ) : null}
        </Box>
      </LeftBar>
    </Box>
  );
};

/** A short, tidy card for cases where the search never produced a payload. */
export const WebSearchErrorView: React.FC<{ message: string; columns?: number }> = ({ message, columns }) => {
  const theme = useTheme();
  const width = contentWidth(columns);
  const text = message.replace(/^Error:\s*/i, '');
  return (
    <Box paddingX={2} marginBottom={1}>
      <LeftBar color={theme.error}>
        <Box flexDirection="column">
          <Text color={theme.error} bold wrap="truncate-end">{'✗ Web search'}</Text>
          <Text color={theme.muted} wrap="truncate-end">{clipToWidth(text, width)}</Text>
        </Box>
      </LeftBar>
    </Box>
  );
};

/** Convenience for callers that only have the raw tool result string. */
export const WebSearchResultView: React.FC<{ raw: string; columns?: number }> = ({ raw, columns }) => {
  const payload = parseWebSearchResult(raw);
  return payload
    ? <WebSearchView payload={payload} columns={columns} />
    : <WebSearchErrorView message={raw} columns={columns} />;
};

export default WebSearchView;

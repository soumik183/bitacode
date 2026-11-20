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
}

const MAX_RESOURCE_CHARS = 170;

function contentWidth(): number {
  return Math.max(40, (process.stdout.columns ?? 80) - 8);
}

function shorten(url: string, width: number): string {
  if (url.length <= width) return url;
  const keep = Math.max(12, width - 1);
  return `${url.slice(0, keep)}…`;
}

function snippet(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= MAX_RESOURCE_CHARS ? one : `${one.slice(0, MAX_RESOURCE_CHARS - 1)}…`;
}

const ResourceRow: React.FC<{ resource: WebSearchResource; width: number; color: string }> = ({ resource, width, color }) => (
  <Box flexDirection="column">
    <Text color={color} wrap="truncate-end">
      {`↗ ${shorten(resource.url, width)}`}
    </Text>
    {resource.text ? (
      <Text color="muted" wrap="wrap">{`   ${snippet(resource.text)}`}</Text>
    ) : null}
  </Box>
);

export const WebSearchView: React.FC<WebSearchViewProps> = ({ payload, maxResources = 24 }) => {
  const theme = useTheme();
  const width = contentWidth();
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
export const WebSearchErrorView: React.FC<{ message: string }> = ({ message }) => {
  const theme = useTheme();
  return (
    <Box paddingX={2} marginBottom={1}>
      <LeftBar color={theme.error}>
        <Box flexDirection="column">
          <Text color={theme.error} bold wrap="truncate-end">{'✗ Web search'}</Text>
          <Text color={theme.muted} wrap="truncate-end">{message.replace(/^Error:\s*/i, '')}</Text>
        </Box>
      </LeftBar>
    </Box>
  );
};

/** Convenience for callers that only have the raw tool result string. */
export const WebSearchResultView: React.FC<{ raw: string }> = ({ raw }) => {
  const payload = parseWebSearchResult(raw);
  return payload ? <WebSearchView payload={payload} /> : <WebSearchErrorView message={raw} />;
};

export default WebSearchView;

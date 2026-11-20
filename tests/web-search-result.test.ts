import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWebSearchResult,
  formatWebSearchResult,
  type WebSearchPayload,
} from '../src/utils/web-search-result.js';

test('parseWebSearchResult reads a multi-query payload', () => {
  const raw = [
    'WEB_SEARCH',
    'QUERY: alpha',
    'RESOURCE: https://example.com/a',
    'TEXT: Hello   world\tagain',
    'QUERY: beta',
    'ERROR: No results found for "beta".',
    'RELATED: alpha examples | beta / guide',
  ].join('\n');
  const payload = parseWebSearchResult(raw);
  assert.ok(payload);
  assert.deepEqual(payload.queries, ['alpha', 'beta']);
  assert.equal(payload.blocks.length, 2);
  assert.deepEqual(payload.blocks[0].resources, [
    { url: 'https://example.com/a', text: 'Hello world again' },
  ]);
  assert.equal(payload.blocks[1].error, 'No results found for "beta".');
  assert.deepEqual(payload.errors, ['No results found for "beta".']);
  assert.deepEqual(payload.related, ['alpha examples', 'beta / guide']);
});

test('parseWebSearchResult ignores unknown lines and keeps multiple errors', () => {
  const raw = [
    'WEB_SEARCH',
    'UNKNOWN: noise',
    'QUERY: alpha',
    'ERROR: first problem',
    'ERROR: second problem',
    'RELATED: a/b',
  ].join('\n');
  const payload = parseWebSearchResult(raw)!;
  assert.deepEqual(payload.errors, ['first problem', 'second problem']);
  assert.equal(payload.blocks[0].error, 'first problem');
  assert.deepEqual(payload.related, ['a/b']);
});

test('parseWebSearchResult round-trips a formatted payload', () => {
  const payload: WebSearchPayload = {
    queries: ['one', 'two'],
    blocks: [
      { query: 'one', resources: [{ url: 'https://a.test', text: 'first snippet' }] },
      { query: 'two', resources: [], error: 'Error: web search timed out after 15s.' },
    ],
    related: ['one guide', 'two guide'],
    errors: ['Error: web search timed out after 15s.'],
  };
  assert.deepEqual(parseWebSearchResult(formatWebSearchResult(payload)), payload);
});

test('parseWebSearchResult returns null for arbitrary or malformed text', () => {
  assert.equal(parseWebSearchResult('hello world'), null);
  assert.equal(parseWebSearchResult(''), null);
  assert.equal(parseWebSearchResult('WEB_SEARCH\nno query here'), null);
  assert.equal(parseWebSearchResult('  WEB_SEARCH\nRELATED: only related  '), null);
});

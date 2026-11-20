import test from 'node:test';
import assert from 'node:assert/strict';
import {
  webSearch,
  parseDdgHtml,
  parseDdgRelated,
  decodeEntities,
} from '../src/tools/web-search.js';
import { parseWebSearchResult } from '../src/utils/web-search-result.js';

function fixtureHtml(suffix = ''): string {
  return [
    '<html><body>',
    '<div class="result">',
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Example <b>Alpha</b></a>',
    `<a class="result__snippet" href="#">Hello &amp; welcome${suffix}</a>`,
    '</div>',
    '<div class="result">',
    '<a rel="nofollow" class="result__a" href="https://beta.example.org/page">Beta &quot;Page&quot;</a>',
    '<div class="result__snippet">Second &lt;snippet&gt; here</div>',
    '</div>',
    '</body></html>',
  ].join('\n');
}

function withFetch(impl: (...args: any[]) => any, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('webSearch validates the query without making a request', async () => {
  assert.match(await webSearch(''), /query is required/i);
  assert.match(await webSearch('   '), /query is required/i);
  assert.match(await webSearch('x'.repeat(501)), /query too long/i);
});

test('webSearch rejects invalid or empty query arrays with the legacy error', async () => {
  assert.equal(await webSearch([]), 'Error: query is required.');
  assert.equal(await webSearch(['', '   ']), 'Error: query is required.');
  assert.equal(await webSearch([] as unknown as string), 'Error: query is required.');
  assert.match(await webSearch(['x'.repeat(501)]), /query too long/i);
});

test('parseDdgHtml extracts title, destination URL and snippet', () => {
  const results = parseDdgHtml(fixtureHtml());
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: 'Example Alpha',
    url: 'https://example.com/a',
    snippet: 'Hello & welcome',
  });
  assert.deepEqual(results[1], {
    title: 'Beta "Page"',
    url: 'https://beta.example.org/page',
    snippet: 'Second <snippet> here',
  });
  assert.equal(decodeEntities('A &amp; B &#39;C&#39;'), "A & B 'C'");
});

test('parseDdgHtml only keeps absolute http(s) URLs (SSRF-safe)', () => {
  const html = [
    '<a class="result__a" href="javascript:alert(1)">JS</a>',
    '<a class="result__a" href="data:text/html,hi">Data</a>',
    '<a class="result__a" href="/relative/path">Relative</a>',
    '<a class="result__a" href="https://safe.example.com/x">Safe</a>',
  ].join('\n');
  assert.deepEqual(parseDdgHtml(html).map((r) => r.url), ['https://safe.example.com/x']);
});

test('parseDdgRelated extracts related searches with a generic fallback', () => {
  const html = [
    '<div class="related-searches">',
    '<a class="related-search-item" data-query="what is foo">what is foo</a>',
    '<a class="related-search-item" data-query="foo tutorial">foo tutorial</a>',
    '</div>',
  ].join('\n');
  assert.deepEqual(parseDdgRelated(html), ['what is foo', 'foo tutorial']);
  assert.deepEqual(parseDdgRelated('<a data-query="bar guide">bar</a>'), ['bar guide']);
  assert.deepEqual(parseDdgRelated('<html>nothing here</html>'), []);
});

test('webSearch returns WEB_SEARCH with QUERY and RESOURCE/TEXT for a single query', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => fixtureHtml() }), async () => {
    const result = await webSearch('example query');
    assert.match(result, /^WEB_SEARCH/);
    const payload = parseWebSearchResult(result)!;
    assert.deepEqual(payload.queries, ['example query']);
    assert.equal(payload.blocks.length, 1);
    assert.equal(payload.errors.length, 0);
    assert.deepEqual(payload.blocks[0].resources, [
      { url: 'https://example.com/a', text: 'Hello & welcome' },
      { url: 'https://beta.example.org/page', text: 'Second <snippet> here' },
    ]);
    assert.deepEqual(payload.related, ['example query examples', 'example query best practices']);
  });
});

test('webSearch runs two queries in parallel and emits one block each', async () => {
  const seen: string[] = [];
  await withFetch(async (url: string) => {
    const q = new URL(url).searchParams.get('q') ?? '';
    seen.push(q);
    return { ok: true, status: 200, text: async () => fixtureHtml(` for ${q}`) };
  }, async () => {
    const result = await webSearch(['alpha', 'beta']);
    const payload = parseWebSearchResult(result)!;
    assert.deepEqual(seen.sort(), ['alpha', 'beta']);
    assert.deepEqual(payload.queries, ['alpha', 'beta']);
    assert.equal(payload.blocks.length, 2);
    assert.equal(payload.errors.length, 0);
    assert.match(payload.blocks[0].resources[0].text, /for alpha/);
    assert.match(payload.blocks[1].resources[0].text, /for beta/);
  });
});

test('webSearch keeps successful blocks when another query fails', async () => {
  await withFetch(async (url: string) => {
    const q = new URL(url).searchParams.get('q');
    if (q === 'bad') return { ok: false, status: 500, statusText: 'Server Error' };
    return { ok: true, status: 200, text: async () => fixtureHtml() };
  }, async () => {
    const result = await webSearch(['bad', 'good']);
    const payload = parseWebSearchResult(result)!;
    assert.equal(payload.blocks.length, 2);
    assert.match(payload.blocks[0].error!, /HTTP 500/);
    assert.equal(payload.blocks[0].resources.length, 0);
    assert.equal(payload.blocks[1].error, undefined);
    assert.equal(payload.blocks[1].resources.length, 2);
    assert.deepEqual(payload.errors, [payload.blocks[0].error]);
  });
});

test('webSearch deduplicates queries case-insensitively and caps at 5', async () => {
  const seen: string[] = [];
  await withFetch(async (url: string) => {
    seen.push(new URL(url).searchParams.get('q') ?? '');
    return { ok: true, status: 200, text: async () => fixtureHtml() };
  }, async () => {
    const result = await webSearch([
      'Alpha', 'alpha', 'ALPHA', 'beta', 'gamma', 'delta', 'epsilon', 'zeta',
    ]);
    const payload = parseWebSearchResult(result)!;
    assert.deepEqual(payload.queries, ['Alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    assert.equal(seen.length, 5);
  });
});

test('webSearch reports blocked providers and timeouts clearly', async () => {
  await withFetch(async () => ({ ok: false, status: 403, statusText: 'Forbidden' }), async () => {
    assert.match(await webSearch('blocked'), /HTTP 403|blocking requests/i);
  });

  await withFetch(async () => ({ ok: true, status: 200, text: async () => '<html>captcha challenge</html>' }), async () => {
    assert.match(await webSearch('bot'), /blocked by the provider/i);
  });

  await withFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
    assert.match(await webSearch('slow'), /timed out/i);
  });
});

test('webSearch retries once on a network error and reports the final failure', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    throw new Error('ECONNRESET');
  }, async () => {
    const result = await webSearch('flaky', 5);
    assert.equal(calls, 2);
    assert.match(result, /ERROR:.*web search failed: ECONNRESET/);
  });
});

test('an external AbortSignal aborts an in-flight search', async () => {
  const controller = new AbortController();
  let captured: AbortSignal | undefined;
  let calls = 0;
  await withFetch(async (_url: string, init: any) => {
    calls++;
    captured = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }, async () => {
    const pending = webSearch('abort me', { timeout: 10, signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.ok(captured?.aborted, 'the fetch signal should be aborted');
    assert.equal(calls, 1, 'an aborted search must not be retried');
    assert.match(result, /ERROR:.*timed out/i);
  });
});

test('webSearch output round-trips through parseWebSearchResult', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => fixtureHtml() }), async () => {
    const payload = parseWebSearchResult(await webSearch(['one', 'two']))!;
    assert.deepEqual(payload.queries, ['one', 'two']);
    assert.equal(payload.blocks.length, 2);
    assert.deepEqual(payload.errors, []);
  });
});

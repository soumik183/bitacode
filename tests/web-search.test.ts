import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, parseDdgHtml, decodeEntities } from '../src/tools/web-search.js';

function fixtureHtml(): string {
  return [
    '<html><body>',
    '<div class="result">',
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Example <b>Alpha</b></a>',
    '<a class="result__snippet" href="#">Hello &amp; welcome</a>',
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

test('webSearch formats parsed results from a successful fetch', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => fixtureHtml() }), async () => {
    const result = await webSearch('example query');
    assert.match(result, /1\. Example Alpha/);
    assert.match(result, /https:\/\/example\.com\/a/);
    assert.match(result, /Hello & welcome/);
    assert.match(result, /2\. Beta "Page"/);
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

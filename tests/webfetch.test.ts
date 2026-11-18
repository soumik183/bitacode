import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterBySelector,
  isUnsafeAddress,
  stripNoiseTags,
  webfetch,
} from '../src/tools/webfetch.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('isUnsafeAddress flags loopback, link-local, private, and metadata IPs', () => {
  const unsafe = [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
  ];
  for (const ip of unsafe) {
    assert.equal(isUnsafeAddress(ip), true, `${ip} should be unsafe`);
  }
});

test('isUnsafeAddress allows public IPs', () => {
  const publicIps = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ];
  for (const ip of publicIps) {
    assert.equal(isUnsafeAddress(ip), false, `${ip} should be public`);
  }
});

test('webfetch rejects private/loopback/metadata URLs before any network call', async () => {
  const urls = [
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
  ];
  for (const url of urls) {
    await assert.rejects(() => webfetch(url, 'text'), /Refusing to fetch/);
  }
});

test('webfetch still rejects non-http(s) and malformed URLs', async () => {
  await assert.rejects(() => webfetch('file:///etc/passwd', 'text'), /protocol/i);
  await assert.rejects(() => webfetch('not a url', 'text'), /Invalid URL/i);
});

test('stripNoiseTags removes navigation chrome but keeps article content', () => {
  const html = [
    '<header>Site header</header>',
    '<nav><a href="/">Home</a></nav>',
    '<main><article>Keep this article text.</article></main>',
    '<aside>Related links</aside>',
    '<form><input /></form>',
    "<script>alert('x')</script>",
    '<style>.x{color:red}</style>',
    '<noscript>Enable JS</noscript>',
    '<svg><path/></svg>',
    '<footer>Copyright</footer>',
  ].join('\n');

  const stripped = stripNoiseTags(html);
  assert.match(stripped, /Keep this article text\./);
  for (const noise of [
    'Site header',
    'Home',
    'Related links',
    'alert(',
    '.x{color:red}',
    'Enable JS',
    'Copyright',
    '<svg',
    '<form',
  ]) {
    assert.doesNotMatch(stripped, new RegExp(esc(noise)));
  }
});

test('filterBySelector narrows to tag, #id, and .class', () => {
  const html = '<nav>menu</nav><article id="main" class="post">Article body</article><footer>foot</footer>';

  const byTag = filterBySelector(html, 'article');
  assert.match(byTag, /Article body/);
  assert.doesNotMatch(byTag, /menu/);

  assert.match(filterBySelector(html, '#main'), /Article body/);
  assert.match(filterBySelector(html, '.post'), /Article body/);
  assert.equal(filterBySelector(html), html, 'no selector returns input unchanged');
});

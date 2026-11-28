import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecret, scanTextForSecrets } from '../src/utils/secret-scan.js';

test('finds classic key shapes with line numbers and redacted previews', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const text = [
    `const key = "${secret}";`,
    'const answer = 42;',
    '-----BEGIN RSA PRIVATE KEY-----',
  ].join('\n');

  const findings = scanTextForSecrets(text);
  assert.ok(findings.some((f) => f.kind === 'OpenAI key' && f.line === 1));
  assert.ok(findings.some((f) => f.kind === 'Private key' && f.line === 3));
  for (const finding of findings) {
    assert.equal(finding.preview.includes(secret), false, 'full key never leaves the scanner');
  }
});

test('clean text has no findings', () => {
  assert.deepEqual(scanTextForSecrets('const x = 1;\nhello world\n'), []);
});

test('redactSecret keeps only a short hint', () => {
  assert.equal(redactSecret('AKIAABCDEFGHIJKLMNOP'), 'AKIA…MNOP');
  assert.equal(redactSecret('short'), '…');
  assert.match(redactSecret('-----BEGIN PRIVATE KEY-----'), /PRIVATE KEY/);
});

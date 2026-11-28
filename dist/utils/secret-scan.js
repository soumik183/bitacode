/**
 * secret-scan.ts — detect leaked credentials in text.
 *
 * Pure and dependency-free so it can run on a single string, a file, or a
 * directory walk. Findings carry a redacted preview only: the full secret is
 * never printed into the transcript or a log.
 */
const RULES = [
    { kind: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
    { kind: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'Private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
    {
        kind: 'Credential assignment',
        pattern: /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-./+=]{16,}['"]/gi,
    },
];
/** Keep a short, non-reversible hint of the match. */
export function redactSecret(value) {
    const text = String(value ?? '');
    if (text.includes('PRIVATE KEY'))
        return '-----BEGIN … PRIVATE KEY-----';
    if (text.length <= 12)
        return '…';
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
/** Scan text, one line at a time, returning at most `maxFindings` hits. */
export function scanTextForSecrets(text, maxFindings = 100) {
    const findings = [];
    if (!text)
        return findings;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && findings.length < maxFindings; index++) {
        const line = lines[index];
        if (!line)
            continue;
        for (const rule of RULES) {
            rule.pattern.lastIndex = 0;
            let match;
            while ((match = rule.pattern.exec(line)) !== null) {
                findings.push({
                    kind: rule.kind,
                    line: index + 1,
                    preview: redactSecret(match[0]),
                });
                if (findings.length >= maxFindings)
                    break;
                if (match[0].length === 0)
                    break;
            }
        }
    }
    return findings;
}

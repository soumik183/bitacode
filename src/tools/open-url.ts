import { spawn } from 'node:child_process';
import { errorMessage, OPEN_URL_TIMEOUT_MS, type OpenUrlArgs } from './task-registry.js';

export const openUrlTool = {
  type: 'function' as const,
  function: {
    name: 'open_url',
    description: 'Open an http(s) URL in the browser via termux-open-url on Termux/Android. No approval needed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An http(s) URL.' },
      },
      required: ['url'],
    },
  },
};

function httpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function openUrl(args: OpenUrlArgs = {}): Promise<string> {
  try {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const url = httpUrl(a.url);
    if (!url) return 'Error: url must be a valid http(s) URL.';

    return await new Promise<string>((resolve) => {
      let child;
      try {
        child = spawn('termux-open-url', [url], { stdio: 'ignore' });
      } catch {
        resolve(`Could not launch termux-open-url. Open manually: ${url}`);
        return;
      }

      let done = false;
      const finish = (message: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(message);
      };
      const fallback = `Could not launch termux-open-url. Open manually: ${url}`;

      child.on('error', () => finish(fallback));
      child.on('close', (code) => finish(code === 0 ? `Opened in browser: ${url}` : fallback));
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* best effort */ }
        finish(`termux-open-url timed out. Open manually: ${url}`);
      }, OPEN_URL_TIMEOUT_MS);
    });
  } catch (err) {
    return errorMessage('open_url', err);
  }
}

/**
 * Test helpers for driving Ink components.
 *
 * Ink renders asynchronously, so tests have to wait for a frame. A fixed
 * `setTimeout(…, 50)` is a race: it fails on a loaded CI runner and passes on
 * a warm laptop. These helpers poll instead, so they settle as soon as the
 * condition holds and only give up after a generous timeout.
 */

/** Default ceiling for a single wait. Generous so slow CI never flakes. */
export const SETTLE_TIMEOUT_MS = 5000;

/** Poll the same frame until `predicate` is happy. */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS
): Promise<string> {
  const start = Date.now();
  let frame = lastFrame() ?? '';

  while (Date.now() - start < timeoutMs) {
    frame = lastFrame() ?? '';
    if (predicate(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Return the final frame so the caller's assertion prints something useful.
  return lastFrame() ?? '';
}

/** Poll until `predicate` is true, for non-render state. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS,
  message = 'condition was not met in time'
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** Let Ink flush pending renders without waiting on a condition. */
export async function settle(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

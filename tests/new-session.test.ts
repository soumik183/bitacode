import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * /new must cancel the running turn. Otherwise the old run keeps emitting and
 * its completion path writes the previous conversation into the new session,
 * which looked like /new doing nothing or duplicating the transcript.
 *
 * This mirrors App's guard: a monotonic run id is captured before the first
 * await, and any run whose id is stale drops its result.
 */
test('a new session supersedes an in-flight run', async () => {
  let activeRun = 0;
  let messages: string[] = ['old user', 'old assistant'];
  let loading = false;

  const startTurn = async () => {
    const runId = activeRun;
    loading = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (runId !== activeRun) return;
    messages = [...messages, 'stale result'];
    if (runId === activeRun) loading = false;
  };

  const startNewSession = async () => {
    activeRun += 1;
    messages = ['system'];
    loading = false;
  };

  loading = true;
  const turn = startTurn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await startNewSession();
  await turn;

  assert.deepEqual(messages, ['system']);
  assert.equal(loading, false);
});

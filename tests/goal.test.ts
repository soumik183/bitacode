import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGoal,
  goalContextBlock,
  parseVerdict,
  recordRound,
  renderGoalPrompt,
  type GoalState,
} from '../src/utils/goal.js';

test('createGoal defaults to a working state with a 5-round budget', () => {
  const state = createGoal('Fix the flaky test');
  assert.deepEqual(state, {
    goal: 'Fix the flaky test',
    rounds: 0,
    maxRounds: 5,
    history: [],
    verdict: 'working',
  });
});

test('createGoal clamps maxRounds into 1..12 and falls back to 5', () => {
  assert.equal(createGoal('x', { maxRounds: 0 }).maxRounds, 1);
  assert.equal(createGoal('x', { maxRounds: -3 }).maxRounds, 1);
  assert.equal(createGoal('x', { maxRounds: 99 }).maxRounds, 12);
  assert.equal(createGoal('x', { maxRounds: 3.7 }).maxRounds, 3);
  assert.equal(createGoal('x', { maxRounds: Number.NaN }).maxRounds, 5);
  assert.equal(createGoal('x', { maxRounds: undefined }).maxRounds, 5);
});

test('createGoal stops on empty, whitespace-only, control-only and oversized goals', () => {
  for (const goal of ['', '   \t ', '\u0000\u001f\u007f', 'x'.repeat(2001)]) {
    const state = createGoal(goal);
    assert.equal(state.verdict, 'stopped');
    assert.deepEqual(state.history, ['invalid goal']);
    assert.equal(state.rounds, 0);
  }
  assert.equal(createGoal('x'.repeat(2000)).verdict, 'working');
  assert.equal(createGoal('x'.repeat(2001), { maxRounds: 2 }).maxRounds, 2);
});

test('createGoal strips control characters and trims the goal', () => {
  const state = createGoal('  fix\u0001the\u007fbug\nnow  ');
  assert.equal(state.goal, 'fixthebugnow');
  assert.equal(state.verdict, 'working');
});

test('renderGoalPrompt includes goal, markers, upcoming round and recent history', () => {
  const state: GoalState = {
    goal: 'Ship the feature',
    rounds: 2,
    maxRounds: 5,
    history: ['oldest', 'step one', 'step two', 'step three'],
    verdict: 'working',
  };
  const prompt = renderGoalPrompt(state);
  assert.match(prompt, /Goal: Ship the feature/);
  assert.match(prompt, /Continue until the goal is met/);
  assert.match(prompt, /VERDICT: PASS/);
  assert.match(prompt, /VERDICT: ISSUES/);
  assert.match(prompt, /Round 3\/5/);
  assert.match(prompt, /- step one\n- step two\n- step three$/);
  assert.doesNotMatch(prompt, /^- oldest$/m);
});

test('renderGoalPrompt bounds each history entry to 500 chars and strips controls', () => {
  const prompt = renderGoalPrompt({
    goal: 'g',
    rounds: 0,
    maxRounds: 5,
    history: [`${'A'.repeat(600)}\u0000tail`],
    verdict: 'working',
  });
  assert.match(prompt, /- A{500}$/);
  assert.doesNotMatch(prompt, /A{501}/);
  assert.doesNotMatch(prompt, /tail/);
});

test('parseVerdict reads PASS and ISSUES case-insensitively with trailing punctuation', () => {
  assert.equal(parseVerdict('VERDICT: PASS'), 'pass');
  assert.equal(parseVerdict('verdict: issues.'), 'issues');
  assert.equal(parseVerdict('done\nVERDICT: PASS!!!'), 'pass');
  assert.equal(parseVerdict('VERDICT:   ISSUES?'), 'issues');
});

test('parseVerdict returns undefined when absent, wrong or not an exact keyword', () => {
  assert.equal(parseVerdict('All done, no marker here'), undefined);
  assert.equal(parseVerdict('VERDICT: MAYBE'), undefined);
  assert.equal(parseVerdict('VERDICT: PASSED'), undefined);
  assert.equal(parseVerdict('VERDICT: ISSUES-FOUND'), undefined);
  assert.equal(parseVerdict('MYVERDICT: PASS'), undefined);
  assert.equal(parseVerdict('' as unknown as string), undefined);
  assert.equal(parseVerdict(undefined as unknown as string), undefined);
});

test('parseVerdict treats two markers in the window as ambiguous', () => {
  assert.equal(parseVerdict('VERDICT: PASS. VERDICT: ISSUES.'), undefined);
  assert.equal(parseVerdict('VERDICT: PASS. VERDICT: PASS.'), undefined);
});

test('parseVerdict only looks at the last 500 chars', () => {
  const text = `VERDICT: PASS${'x'.repeat(600)}\nVERDICT: ISSUES`;
  assert.equal(parseVerdict(text), 'issues');
  assert.equal(parseVerdict(`VERDICT: PASS${'x'.repeat(600)}`), undefined);
});

test('recordRound progresses rounds and treats a missing verdict as working', () => {
  const start = createGoal('Refactor parser');
  const first = recordRound(start, 'moved the parser');
  assert.equal(first.rounds, 1);
  assert.equal(first.verdict, 'working');
  assert.deepEqual(first.history, ['moved the parser']);

  const second = recordRound(first, 'still failing', 'no marker in this answer');
  assert.equal(second.rounds, 2);
  assert.equal(second.verdict, 'working');
  assert.deepEqual(second.history, ['moved the parser', 'still failing']);
});

test('recordRound turns PASS into a terminal pass, even on the last round', () => {
  const start = createGoal('Build it', { maxRounds: 1 });
  const done = recordRound(start, 'all green', 'VERDICT: PASS');
  assert.equal(done.rounds, 1);
  assert.equal(done.verdict, 'pass');
  assert.equal(goalContextBlock(done).includes('status="pass"'), true);
});

test('recordRound fails when ISSUES exhausts the round budget', () => {
  let state = createGoal('Build it', { maxRounds: 2 });
  state = recordRound(state, 'first attempt', 'VERDICT: ISSUES');
  assert.equal(state.verdict, 'working');
  state = recordRound(state, 'second attempt', 'VERDICT: ISSUES');
  assert.equal(state.rounds, 2);
  assert.equal(state.verdict, 'fail');
  assert.equal(goalContextBlock(state), '');
});

test('recordRound is immutable and never aliases the previous history', () => {
  const start = createGoal('Keep state pure');
  const snapshot: GoalState = structuredClone(start);
  const next = recordRound(start, 'one', 'VERDICT: ISSUES');
  assert.deepEqual(start, snapshot);
  assert.notEqual(next, start);
  assert.notEqual(next.history, start.history);
  assert.equal(next.history.length, 1);
});

test('recordRound sanitizes and caps summaries at 1000 chars and history at 12', () => {
  const long = `${'S'.repeat(1200)}\u0000ctrl`;
  let state = createGoal('Bound the history', { maxRounds: 12 });
  state = recordRound(state, long);
  assert.equal(state.history[0], 'S'.repeat(1000));
  assert.doesNotMatch(state.history[0], /ctrl/);

  for (let i = 1; i < 15; i += 1) {
    state = recordRound(state, `step ${i}`);
  }
  assert.equal(state.history.length, 12);
  assert.equal(state.history[0], 'step 3');
  assert.equal(state.history[11], 'step 14');
  assert.equal(state.rounds, 12);
});

test('goalContextBlock renders only for working/pass states and escapes XML', () => {
  const start = createGoal('<script> & "quotes"');
  const block = goalContextBlock(start);
  assert.match(block, /^<goal status="working" round="0\/5">/);
  assert.match(block, /&lt;script&gt; &amp; "quotes"/);
  assert.match(block, /<\/goal>$/);

  const stopped = createGoal('');
  assert.equal(goalContextBlock(stopped), '');
  assert.equal(goalContextBlock(null as unknown as GoalState), '');
});

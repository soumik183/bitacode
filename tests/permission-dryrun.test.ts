import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePermission,
  matchRules,
  parseRuleSet,
} from '../src/utils/permission-rules.js';

test('deny beats ask and allow, and matchRules reports every bucket', () => {
  const set = parseRuleSet({
    allow: ['bash(git status *)'],
    ask: ['bash(git *)'],
    deny: ['bash(git push *)'],
  });
  const call = { tool: 'bash', args: { command: 'git push origin main' } };

  const evaluation = evaluatePermission(set, call);
  assert.equal(evaluation.decision, 'deny');
  assert.equal(evaluation.rule, 'bash(git push *)');

  const matches = matchRules(set, call);
  assert.equal(matches.deny.length, 1);
  assert.equal(matches.ask.length, 1);
  assert.equal(matches.allow.length, 0);
});

test('path rules match project-relative write targets', () => {
  const set = parseRuleSet({ deny: ['write_file(.git/**)'] });
  const evaluation = evaluatePermission(set, {
    tool: 'write_file',
    args: { file_path: '.git/config' },
    cwd: process.cwd(),
  });
  assert.equal(evaluation.decision, 'deny');
});

test('an unmatched call defaults to ask', () => {
  const set = parseRuleSet({ allow: ['read_file(src/**)'] });
  const evaluation = evaluatePermission(set, { tool: 'read_file', args: { file_path: 'docs/x.md' } });
  assert.equal(evaluation.decision, 'ask');
});

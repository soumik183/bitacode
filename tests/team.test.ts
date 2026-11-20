import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TEAM,
  postMessage,
  readMessages,
  listTeams,
  clearTeam,
  teamRoster,
  defineAgent,
  getAgent,
  listAgents,
  clearAgents,
  recordSpawnIntent,
  clearSpawnIntents,
} from '../src/utils/team.js';
import { agentMessage, getQueuedMessages, clearQueuedMessages } from '../src/tools/agent-message.js';
import { teamPost, teamRead, teamList, teamSpawn, agentDefine } from '../src/tools/team.js';
import { handleToolCall } from '../src/tools/index.js';

test('postMessage stores channel and direct messages with ids and timestamps', () => {
  clearTeam(DEFAULT_TEAM);
  clearTeam('team-msg-1');

  const broadcast = postMessage(DEFAULT_TEAM, 'parent', '*', 'hello all');
  assert.ok(broadcast);
  assert.equal(broadcast.seq, 1);
  assert.equal(broadcast.id, `${DEFAULT_TEAM}:1`);
  assert.equal(broadcast.from, 'parent');
  assert.equal(broadcast.to, '*');
  assert.equal(broadcast.body, 'hello all');
  assert.equal(typeof broadcast.at, 'number');
  assert.ok(broadcast.at > 0);

  const direct = postMessage('team-msg-1', 'alice', 'bob', 'private');
  assert.ok(direct);
  assert.equal(direct.seq, 1, 'sequence numbers are per team');
  assert.equal(direct.id, 'team-msg-1:1');
  assert.deepEqual(listTeams().slice(0, 2), [DEFAULT_TEAM, 'team-msg-1']);

  // A returned message is a copy: mutating it cannot change the registry.
  broadcast.body = 'tampered';
  assert.equal(readMessages(DEFAULT_TEAM)[0]?.body, 'hello all');
  assert.equal(postMessage('team-msg-1', '', 'bob', 'x'), null, 'missing sender is rejected');
  assert.equal(postMessage('team-msg-1', 'alice', 'bob', '   '), null, 'empty body is rejected');

  clearTeam(DEFAULT_TEAM);
  clearTeam('team-msg-1');
});

test('sequence numbers increase and after filters by seq', () => {
  clearTeam('team-seq');
  for (const body of ['m1', 'm2', 'm3']) {
    assert.ok(postMessage('team-seq', 'parent', '*', body));
  }
  assert.deepEqual(readMessages('team-seq').map((m) => m.seq), [1, 2, 3]);
  assert.deepEqual(readMessages('team-seq').map((m) => m.body), ['m1', 'm2', 'm3']);
  assert.deepEqual(readMessages('team-seq', 1).map((m) => m.seq), [2, 3]);
  assert.deepEqual(readMessages('team-seq', 99), []);
  assert.deepEqual(readMessages('team-seq-does-not-exist'), []);
  clearTeam('team-seq');
});

test('to filter returns direct messages plus channel broadcasts', () => {
  clearTeam('team-filter');
  postMessage('team-filter', 'parent', '*', 'broadcast');
  postMessage('team-filter', 'alice', 'bob', 'direct-bob');
  postMessage('team-filter', 'alice', 'carol', 'direct-carol');

  assert.deepEqual(readMessages('team-filter', 0, 'bob').map((m) => m.body), ['broadcast', 'direct-bob']);
  assert.deepEqual(readMessages('team-filter', 0, 'carol').map((m) => m.body), ['broadcast', 'direct-carol']);
  assert.deepEqual(readMessages('team-filter', 0, 'nobody').map((m) => m.body), ['broadcast']);
  clearTeam('team-filter');
});

test('teamRoster reports members and clearTeam removes a channel', () => {
  clearTeam('team-roster');
  clearSpawnIntents();
  postMessage('team-roster', 'alice', '*', 'hi');
  postMessage('team-roster', 'bob', 'alice', 'yo');
  recordSpawnIntent('carol', 'do work', 'team-roster');

  const roster = teamRoster().find((entry) => entry.team === 'team-roster');
  assert.ok(roster);
  assert.deepEqual(roster.members, ['alice', 'bob', 'carol']);
  assert.equal(roster.messageCount, 2);
  assert.equal(roster.lastSeq, 2);

  clearTeam('team-roster');
  assert.equal(listTeams().includes('team-roster'), false);
  assert.equal(teamRoster().some((entry) => entry.team === 'team-roster'), false);
  clearSpawnIntents();
});

test('agent definitions are registered in memory and cloned on read', () => {
  clearAgents();
  const definition = defineAgent('reviewer', 'reviews code', 'You are a reviewer.', ['read_file', 'grep']);
  assert.equal(definition?.name, 'reviewer');
  assert.deepEqual(definition?.allowedTools, ['read_file', 'grep']);
  assert.equal(defineAgent('', 'x', 'y'), null);
  assert.equal(listAgents().length, 1);
  assert.equal(getAgent('reviewer')?.systemPrompt, 'You are a reviewer.');

  const snapshot = getAgent('reviewer')!;
  snapshot.allowedTools.push('extra');
  assert.deepEqual(getAgent('reviewer')?.allowedTools, ['read_file', 'grep']);
  clearAgents();
});

test('team tools post, read, list, spawn and define with argument validation', async () => {
  clearTeam('team-tools');
  clearAgents();
  try {
    const posted = await teamPost({ body: 'ping', to: 'bob', team: 'team-tools', from: 'alice' });
    assert.match(posted, /Message #1 posted to teammate "bob" in team "team-tools" by alice\./);
    assert.match(await teamPost({ body: '', team: 'team-tools' }), /^Error: message must be a non-empty string\./);

    const read = await teamRead({ team: 'team-tools', after: 0 });
    assert.match(read, /#1 alice → bob: ping/);
    assert.match(await teamRead({ team: 'team-tools', after: 1 }), /No messages in team "team-tools" after seq 1/);
    assert.match(await teamList(), /team-tools/);

    assert.match(await teamSpawn({ name: '', task: 'x' }), /^Error: name must be a non-empty string\./);
    assert.match(await teamSpawn({ name: 'x', task: '' }), /^Error: task must be a non-empty string\./);
    const spawned = await teamSpawn({ name: 'worker', task: 'do it', team: 'team-tools' });
    assert.match(spawned, /Spawn intent .* recorded for "worker" on team "team-tools"\. No child was started\./);

    assert.match(await agentDefine({ name: '', description: 'x', system_prompt: 'y' }), /^Error: name/);
    assert.match(await agentDefine({ name: 'helper' }), /^Error: description/);
    const defined = await agentDefine({
      name: 'helper', description: 'helps', system_prompt: 'Be helpful.', allowed_tools: ['read_file'],
    });
    assert.match(defined, /Agent definition "helper" registered/);
    assert.match(defined, /Allowed tools: read_file/);
  } finally {
    clearTeam('team-tools');
    clearAgents();
    clearSpawnIntents();
  }
});

test('agent_message supports team addressing and reads without breaking legacy queueing', async () => {
  clearTeam('team-am');
  clearQueuedMessages('legacy-agent');
  try {
    const posted = await agentMessage({ to: '*', message: 'team note', team: 'team-am', from: 'parent' });
    assert.match(posted, /Message #1 posted to the team channel in team "team-am" by parent\./);

    const read = await agentMessage({ action: 'read', team: 'team-am', after: 0 });
    assert.match(read, /#1 parent → \*: team note/);

    const legacy = await agentMessage({ id: 'legacy-agent', message: 'legacy hi' });
    assert.match(legacy, /Message queued for sub-agent "legacy-agent"/);
    assert.deepEqual(getQueuedMessages('legacy-agent'), ['legacy hi']);
    assert.match(await agentMessage({ id: '', message: 'x' }), /^Error: id must be a non-empty string\./);
  } finally {
    clearTeam('team-am');
    clearQueuedMessages('legacy-agent');
  }
});

test('dispatcher validates required tool arguments and folds aliases', async () => {
  clearTeam('team-dispatch');
  try {
    assert.match(await handleToolCall('team_post', { to: 'bob' }), /team_post requires body/);
    assert.match(await handleToolCall('team_spawn', { name: 'x' }), /team_spawn requires task/);
    assert.match(await handleToolCall('agent_define', { name: 'x', description: 'y' }), /agent_define requires system_prompt/);
    const result = await handleToolCall('team_post', { message: 'alias body', to: 'bob', team: 'team-dispatch' });
    assert.match(result, /Message #1 posted to teammate "bob"/);
    assert.match(await handleToolCall('team_read', { team: 'team-dispatch' }), /alias body/);
  } finally {
    clearTeam('team-dispatch');
  }
});

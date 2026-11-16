import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSessionApprovals,
  getApprovalMode,
  isDangerouslySkipPermissions,
  requestApproval,
  resetApprovalStateForTests,
  setApprovalHandler,
  setApprovalMode,
  setDangerouslySkipPermissions,
  type ApprovalRequest,
  type ApprovalResponse,
} from '../src/utils/approval.js';

const REQ: ApprovalRequest = { id: 'req-1', type: 'file_write', description: 'write a file' };
const SHELL_REQ: ApprovalRequest = { id: 'req-2', type: 'shell_command', description: 'run a command' };

test.beforeEach(() => {
  resetApprovalStateForTests();
});

test('manual mode defaults to fail-closed with no registered handler', async () => {
  assert.equal(getApprovalMode(), 'manual');
  assert.equal(await requestApproval(REQ), false);
});

test('manual mode calls the handler and honors approve_once / reject', async () => {
  let calls = 0;
  let response: ApprovalResponse = 'approve_once';
  setApprovalHandler(async () => {
    calls += 1;
    return response;
  });

  assert.equal(await requestApproval(REQ), true);
  assert.equal(calls, 1);

  response = 'reject';
  assert.equal(await requestApproval(REQ), false);
  assert.equal(calls, 2);
});

test('manual mode approve_session is remembered only for its scoped key', async () => {
  let calls = 0;
  setApprovalHandler(async () => {
    calls += 1;
    return 'approve_session';
  });

  assert.equal(await requestApproval(REQ), true);
  assert.equal(await requestApproval(REQ), true); // same session + type → no new prompt
  assert.equal(calls, 1);

  assert.equal(await requestApproval(SHELL_REQ), true); // different type → new prompt
  assert.equal(calls, 2);

  clearSessionApprovals();
  assert.equal(await requestApproval(REQ), true);
  assert.equal(calls, 3);
});

test('auto mode approves without ever calling the handler', async () => {
  let calls = 0;
  setApprovalHandler(async () => {
    calls += 1;
    return 'reject';
  });

  setApprovalMode('auto');

  assert.equal(getApprovalMode(), 'auto');
  assert.equal(await requestApproval(REQ), true);
  assert.equal(await requestApproval(SHELL_REQ), true);
  assert.equal(calls, 0);
  assert.equal(isDangerouslySkipPermissions(), false);
});

test('yolo mode approves, never prompts, and agrees with the skip-permissions flag', async () => {
  let calls = 0;
  setApprovalHandler(async () => {
    calls += 1;
    return 'reject';
  });

  setApprovalMode('yolo');

  assert.equal(getApprovalMode(), 'yolo');
  assert.equal(isDangerouslySkipPermissions(), true);
  assert.equal(await requestApproval(REQ), true);
  assert.equal(await requestApproval(SHELL_REQ), true);
  assert.equal(calls, 0);
});

test('the CLI dangerously-skip-permissions flag still forces auto-approval in manual mode', async () => {
  setDangerouslySkipPermissions(true);

  assert.equal(isDangerouslySkipPermissions(), true);
  assert.equal(await requestApproval(REQ), true); // no handler registered
});

test('switching back from yolo clears the flag, but not an explicit CLI override', () => {
  setApprovalMode('yolo');
  assert.equal(isDangerouslySkipPermissions(), true);

  setApprovalMode('manual');
  assert.equal(isDangerouslySkipPermissions(), false);

  setApprovalMode('auto');
  assert.equal(isDangerouslySkipPermissions(), false);

  // CLI flag set first: switching modes must not clear it.
  setDangerouslySkipPermissions(true);
  setApprovalMode('manual');
  assert.equal(isDangerouslySkipPermissions(), true);
  setApprovalMode('auto');
  assert.equal(isDangerouslySkipPermissions(), true);
});

test('mode switching is idempotent', async () => {
  setApprovalMode('auto');
  setApprovalMode('auto');
  assert.equal(getApprovalMode(), 'auto');

  setApprovalMode('yolo');
  setApprovalMode('yolo');
  assert.equal(getApprovalMode(), 'yolo');
  assert.equal(isDangerouslySkipPermissions(), true);

  setApprovalMode('manual');
  setApprovalMode('manual');
  assert.equal(getApprovalMode(), 'manual');
  assert.equal(isDangerouslySkipPermissions(), false);
  assert.equal(await requestApproval(REQ), false); // fail closed again
});

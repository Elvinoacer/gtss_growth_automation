/**
 * canStart tests — pipeline start authorization.
 *
 * Verifies:
 *  - canStart returns true for a manual run on a disabled schedule
 *  - canStart returns false when paused and no force flag is set
 *  - canStart returns true when paused and the force flag overrides the pause
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockDB, setupMocks } = require('./_mockDb');

test('canStart returns true for a manual run on a disabled schedule', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach', { enabled: 0 });
  db._setPaused('outreach', false);

  const pipelineState = require('../../src/services/pipelineStateService');
  assert.equal(pipelineState.canStart('outreach'), true);

  restore();
});

test('canStart returns false when paused and no force', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', true);

  const pipelineState = require('../../src/services/pipelineStateService');
  assert.equal(pipelineState.canStart('outreach'), false);
  assert.equal(pipelineState.canStart('outreach', { force: true }), true);

  restore();
});

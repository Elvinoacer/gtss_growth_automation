/**
 * requestResume tests — schedule-level pause flag clearing.
 *
 * Verifies requestResume on a schedule-level pause (no active execution)
 * clears the pause flag and reports scheduleLevel:true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockDB, setupMocks } = require('./_mockDb');

test('requestResume on a schedule-level pause (no active execution) clears the pause flag', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach', { last_status: 'paused', current_state: 'paused' });
  db._setPaused('outreach', true);

  const pipelineState = require('../../src/services/pipelineStateService');
  const result = pipelineState.requestResume('outreach');

  assert.equal(result.ok, true);
  assert.equal(result.scheduleLevel, true);
  assert.equal(db.settings.get('pipeline_outreach_paused'), 'false');

  restore();
});

/**
 * requestStop tests — schedule-level stop with stuck DB row sweep.
 *
 * Verifies requestStop on a schedule-level pause (no active execution) sweeps
 * the stuck DB row, marks it as 'stopped', and reports sweptDb:true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockDB, setupMocks } = require('./_mockDb');

test('requestStop on a schedule-level pause (no active execution) sweeps the stuck DB row', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const execId = 'exec-stuck-stop';
  db._addExecution(execId, 'outreach', 'running');

  const pipelineState = require('../../src/services/pipelineStateService');
  const result = pipelineState.requestStop('outreach');

  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.sweptDb, true);
  assert.equal(result.executionId, execId);
  assert.equal(db.executions.get(execId).status, 'stopped');

  restore();
});

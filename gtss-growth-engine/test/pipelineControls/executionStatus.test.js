/**
 * Execution status & lifecycle tests.
 *
 * Verifies:
 *  - hasStuckDbRow detects transient-state rows (running / paused / etc.)
 *  - isExecutionProgressing returns true for recently-updated rows and false
 *    when the row hasn't been updated in over 2 minutes
 *  - createExecution refuses when an active execution already exists
 *  - markExecutionFailed does not overwrite an already-STOPPED state
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockDB, setupMocks } = require('./_mockDb');

test('hasStuckDbRow detects transient-state rows', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../../src/services/pipelineStateService');

  assert.equal(pipelineState.hasStuckDbRow('outreach'), false);

  db._addExecution('exec-1', 'outreach', 'running');
  assert.equal(pipelineState.hasStuckDbRow('outreach'), true);

  db.executions.get('exec-1').status = 'completed';
  assert.equal(pipelineState.hasStuckDbRow('outreach'), false);

  restore();
});

test('isExecutionProgressing returns true for recently-updated rows', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../../src/services/pipelineStateService');

  assert.equal(pipelineState.isExecutionProgressing('outreach'), false);

  const execId = 'exec-progress';
  db._addExecution(execId, 'outreach', 'running', {
    updated_at: new Date().toISOString(),
  });
  pipelineState.__setActive('outreach', execId);

  assert.equal(pipelineState.isExecutionProgressing('outreach'), true);

  db.executions.get(execId).updated_at = new Date(Date.now() - 120_000).toISOString();
  assert.equal(pipelineState.isExecutionProgressing('outreach'), false);

  restore();
});

test('createExecution refuses when an active execution already exists', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../../src/services/pipelineStateService');

  // First execution should succeed
  const exec1 = pipelineState.createExecution('outreach', 'manual', {
    startMessage: 'test', totalSteps: 4,
  });
  assert.ok(exec1.id);

  // Second execution should refuse
  assert.throws(
    () => pipelineState.createExecution('outreach', 'manual', {}),
    /already running/i,
  );

  restore();
});

test('markExecutionFailed does not overwrite a STOPPED state', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../../src/services/pipelineStateService');

  const execId = 'exec-stopped';
  db._addExecution(execId, 'outreach', 'stopped', {
    finished_at: new Date().toISOString(),
  });

  // Should be a no-op because the execution is already STOPPED
  const result = pipelineState.markExecutionFailed(execId, new Error('test'), 'discovery');
  assert.equal(result, false);
  assert.equal(db.executions.get(execId).status, 'stopped');

  restore();
});

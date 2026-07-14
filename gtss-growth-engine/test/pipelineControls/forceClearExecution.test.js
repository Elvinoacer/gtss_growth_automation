/**
 * forceClearExecution tests.
 *
 * Verifies:
 *  - stuck DB rows are marked as failed and schedule state is reset
 *  - schedule-level pause flag is cleared by default
 *  - schedule-level pause flag is preserved when keepPauseIntent:true
 *  - content_pipeline_lock DB setting is released
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockDB, setupMocks } = require('./_mockDb');

test('forceClearExecution marks stuck DB rows as failed and resets schedule state', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);
  db._addExecution('exec-stuck-1', 'outreach', 'running', {
    started_at: new Date(Date.now() - 600_000).toISOString(),
    updated_at: new Date(Date.now() - 300_000).toISOString(),
    current_stage: 'discovery',
  });

  const pipelineState = require('../../src/services/pipelineStateService');
  const result = pipelineState.forceClearExecution('outreach', 'test');

  assert.equal(result.ok, true);
  assert.equal(result.cleared, 1);
  assert.equal(result.previousStatus, 'running');

  const row = db.executions.get('exec-stuck-1');
  assert.equal(row.status, 'failed');
  assert.equal(row.state, 'failed');
  assert.ok(row.error_message.includes('Force-cleared'));
  assert.ok(row.finished_at);

  restore();
});

test('forceClearExecution clears the schedule-level pause flag by default', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', true);

  const pipelineState = require('../../src/services/pipelineStateService');
  pipelineState.forceClearExecution('outreach', 'test');

  assert.equal(db.settings.get('pipeline_outreach_paused'), 'false');

  restore();
});

test('forceClearExecution preserves the pause flag when keepPauseIntent is true', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', true);

  const pipelineState = require('../../src/services/pipelineStateService');
  pipelineState.forceClearExecution('outreach', 'test', { keepPauseIntent: true });

  assert.equal(db.settings.get('pipeline_outreach_paused'), 'true');

  restore();
});

test('forceClearExecution releases the content pipeline DB lock', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('content');
  db._setPaused('content', false);
  db.settings.set('content_pipeline_lock', 'true');

  const pipelineState = require('../../src/services/pipelineStateService');
  pipelineState.forceClearExecution('content', 'test');

  assert.equal(db.settings.get('content_pipeline_lock'), 'false');

  restore();
});

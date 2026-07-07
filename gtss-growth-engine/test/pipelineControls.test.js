/**
 * pipelineControls.test.js — Unit tests for the pipeline control state machine.
 *
 * These tests mock the database and socket layer so they can run without
 * better-sqlite3 installed. They exercise the state machine transitions
 * that the 7 control buttons (Start / Restart / Pause / Stop / Retry /
 * Resume / Force Clear) depend on.
 *
 * Run with: `node --test test/pipelineControls.test.js`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Mock database ────────────────────────────────────────────────────────────

class MockDB {
  constructor() {
    this.executions = new Map();
    this.schedules = new Map();
    this.settings = new Map();
    this.checkpoints = [];
  }

  prepare(sql) {
    const self = this;
    return {
      run: (...params) => self._run(sql, params),
      get: (...params) => self._get(sql, params),
      all: (...params) => self._all(sql, params),
    };
  }
  exec() {}
  pragma() {}

  _run(sql, params) {
    const sqlLower = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    if (sqlLower.startsWith('insert into pipeline_executions')) {
      const [id, pipelineId, trigger, startStage, startMessage, totalSteps, maxRetries, metadataJson] = params;
      const row = {
        id, pipeline_id: pipelineId, trigger,
        status: 'running', state: 'running',
        current_stage: startStage, current_message: startMessage,
        progress: 0, total_steps: totalSteps || 0, completed_steps: 0,
        max_retries: maxRetries || 3, metadata_json: metadataJson,
        retry_count: 0, failed_stage: null, error_message: null, stack_trace: null,
        started_at: new Date().toISOString(), finished_at: null,
        paused_at: null, resumed_at: null, stopped_at: null,
        duration_ms: null,
        updated_at: new Date().toISOString(),
      };
      this.executions.set(id, row);
      return { lastInsertRowid: id, changes: 1 };
    }

    if (sqlLower.startsWith('update pipeline_executions')) {
      const setMatch = sql.match(/SET\s+(.+?)\s+WHERE id = \?/is);
      if (setMatch) {
        const setClauses = setMatch[1].split(',').map(s => s.trim());
        const execId = params[params.length - 1];
        const row = this.executions.get(execId);
        if (!row) return { changes: 0 };
        let paramIdx = 0;
        for (const clause of setClauses) {
          const colMatch = clause.match(/^(\w+)\s*=\s*(.+)$/);
          if (!colMatch) continue;
          const col = colMatch[1];
          const valueExpr = colMatch[2].trim();
          if (valueExpr === '?') {
            row[col] = params[paramIdx++];
          } else if (valueExpr.includes('current_timestamp')) {
            row[col] = new Date().toISOString();
          } else if (valueExpr.startsWith("'") && valueExpr.endsWith("'")) {
            // Literal string value
            row[col] = valueExpr.slice(1, -1);
          } else if (valueExpr.includes('coalesce')) {
            // Skip COALESCE expressions — too complex to parse
            paramIdx++;
          }
        }
        row.updated_at = new Date().toISOString();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (sqlLower.startsWith('update pipeline_schedules')) {
      const idParam = params[params.length - 1];
      const row = this.schedules.get(idParam);
      if (!row) return { changes: 0 };
      // Best-effort: parse simple SET col = ? patterns
      const setMatch = sql.match(/SET\s+(.+?)\s+WHERE id = \?/i);
      if (setMatch) {
        const setClauses = setMatch[1].split(',').map(s => s.trim());
        let paramIdx = 0;
        for (const clause of setClauses) {
          const colMatch = clause.match(/^(\w+)\s*=/);
          if (!colMatch) continue;
          const col = colMatch[1];
          if (clause.includes('?')) {
            row[col] = params[paramIdx++];
          } else if (clause.includes('current_timestamp')) {
            row[col] = new Date().toISOString();
          } else if (clause.includes('coalesce') || clause.includes('case')) {
            paramIdx++;
          }
        }
      }
      row.updated_at = new Date().toISOString();
      return { changes: 1 };
    }

    if (sqlLower.startsWith('insert into settings')) {
      // UPSERT pattern: INSERT INTO settings (key, value) VALUES (?, 'false')
      // ON CONFLICT(key) DO UPDATE SET value = 'false'
      // The key is params[0]. The value is either params[1] or a literal
      // in the SQL. We check both.
      const key = params[0];
      let value = params[1];
      if (value === undefined) {
        // Try to extract the literal value from the SQL
        const valMatch = sql.match(/values\s*\([^,]+,\s*'([^']+)'/i);
        if (valMatch) value = valMatch[1];
        else value = 'false';
      }
      this.settings.set(String(key), String(value));
      return { changes: 1 };
    }

    if (sqlLower.startsWith('update settings set value')) {
      // Parse: UPDATE settings SET value = ? WHERE key = ?
      // OR: UPDATE settings SET value = 'false' WHERE key = '...'
      const valMatch = sql.match(/set value\s*=\s*\?/i);
      const keyMatch = sql.match(/where key\s*=\s*\?/i);
      if (valMatch && keyMatch) {
        // params[0] = value, params[1] = key
        this.settings.set(String(params[1]), String(params[0]));
        return { changes: 1 };
      }
      // Literal version: UPDATE settings SET value = 'false' WHERE key = 'content_pipeline_lock'
      const literalValMatch = sql.match(/set value\s*=\s*'([^']+)'/i);
      const literalKeyMatch = sql.match(/where key\s*=\s*'([^']+)'/i);
      if (literalValMatch && literalKeyMatch) {
        this.settings.set(literalKeyMatch[1], literalValMatch[1]);
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (sqlLower.startsWith('delete from pipeline_checkpoints')) {
      const [execId, stage] = params;
      const before = this.checkpoints.length;
      this.checkpoints = this.checkpoints.filter(c =>
        !(c.execution_id === execId && (stage === undefined || c.stage === stage))
      );
      return { changes: before - this.checkpoints.length };
    }

    return { changes: 0 };
  }

  _get(sql, params) {
    const sqlLower = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    if (sqlLower.startsWith('select * from pipeline_executions where id = ?')) {
      return this.executions.get(params[0]) || undefined;
    }

    if (sqlLower.startsWith('select id, pipeline_id, status from pipeline_executions')) {
      const row = this.executions.get(params[0]);
      return row ? { id: row.id, pipeline_id: row.pipeline_id, status: row.status } : undefined;
    }

    if (sqlLower.startsWith('select id, status, started_at from pipeline_executions')) {
      const stuck = [];
      for (const row of this.executions.values()) {
        if (row.pipeline_id === params[0] &&
            ['running', 'paused', 'resuming', 'stopping', 'retrying'].includes(row.status)) {
          stuck.push({ id: row.id, status: row.status, started_at: row.started_at });
        }
      }
      stuck.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
      return stuck[0];
    }

    if (sqlLower.startsWith('select id, status from pipeline_executions')) {
      // Used by requestStop's DB sweep: SELECT id, status FROM pipeline_executions WHERE pipeline_id = ? AND status IN (...) ORDER BY started_at DESC LIMIT 1
      const stuck = [];
      for (const row of this.executions.values()) {
        if (row.pipeline_id === params[0] &&
            ['running', 'paused', 'resuming', 'stopping', 'retrying'].includes(row.status)) {
          stuck.push({ id: row.id, status: row.status });
        }
      }
      stuck.sort((a, b) => {
        const ra = this.executions.get(a.id);
        const rb = this.executions.get(b.id);
        return (rb?.started_at || '').localeCompare(ra?.started_at || '');
      });
      return stuck[0];
    }

    if (sqlLower.startsWith('select id from pipeline_executions')) {
      const matches = [];
      for (const row of this.executions.values()) {
        if (row.pipeline_id === params[0]) {
          if (sql.includes("'failed'") && row.status === 'failed') matches.push(row);
          else if (sql.includes("'stopped'") && row.status === 'stopped') matches.push(row);
          else if (sql.includes("'failed', 'stopped'") && (row.status === 'failed' || row.status === 'stopped')) matches.push(row);
        }
      }
      matches.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
      return matches[0] ? { id: matches[0].id } : undefined;
    }

    if (sqlLower.startsWith('select * from pipeline_schedules where id = ?')) {
      return this.schedules.get(params[0]);
    }

    if (sqlLower.startsWith('select id from pipeline_schedules where id = ?')) {
      return this.schedules.has(params[0]) ? { id: params[0] } : undefined;
    }

    if (sqlLower.startsWith('select value from settings where key = ?')) {
      const v = this.settings.get(params[0]);
      return v !== undefined ? { value: v } : undefined;
    }

    if (sqlLower.startsWith('select 1 from pipeline_checkpoints')) {
      const [execId, stage] = params;
      const found = this.checkpoints.find(c =>
        c.execution_id === execId &&
        (stage === undefined || c.stage === stage) &&
        (sql.includes("'completed'") ? c.status === 'completed' : true)
      );
      return found ? { 1: 1 } : undefined;
    }

    if (sqlLower.startsWith('select 1 from pipeline_executions')) {
      // Used by hasStuckDbRow: SELECT 1 FROM pipeline_executions WHERE pipeline_id = ? AND status IN (...) LIMIT 1
      const pipelineId = params[0];
      for (const row of this.executions.values()) {
        if (row.pipeline_id === pipelineId &&
            ['running', 'paused', 'resuming', 'stopping', 'retrying'].includes(row.status)) {
          return { 1: 1 };
        }
      }
      return undefined;
    }

    if (sqlLower.startsWith('select status from pipeline_executions where id = ?')) {
      const row = this.executions.get(params[0]);
      return row ? { status: row.status } : undefined;
    }

    if (sqlLower.startsWith('select started_at, finished_at from pipeline_executions')) {
      const row = this.executions.get(params[0]);
      return row ? { started_at: row.started_at, finished_at: row.finished_at } : undefined;
    }

    if (sqlLower.startsWith('select id, pipeline_id, status, current_stage, current_message, progress, started_at, finished_at from pipeline_executions')) {
      return this.executions.get(params[0]);
    }

    return undefined;
  }

  _all(sql, params) {
    const sqlLower = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    if (sqlLower.startsWith('select id, status, started_at from pipeline_executions where pipeline_id = ?')) {
      const stuck = [];
      for (const row of this.executions.values()) {
        if (row.pipeline_id === params[0] &&
            ['running', 'paused', 'resuming', 'stopping', 'retrying'].includes(row.status)) {
          stuck.push({ id: row.id, status: row.status, started_at: row.started_at });
        }
      }
      stuck.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
      return stuck;
    }

    if (sqlLower.startsWith('select * from pipeline_checkpoints where execution_id = ?')) {
      return this.checkpoints.filter(c => c.execution_id === params[0]);
    }

    if (sqlLower.startsWith('select distinct stage from pipeline_checkpoints')) {
      const stages = new Set();
      for (const c of this.checkpoints) {
        if (c.execution_id === params[0] && c.status === 'completed') {
          stages.add(c.stage);
        }
      }
      return [...stages].map(s => ({ stage: s }));
    }

    if (sqlLower.startsWith('select key from settings')) {
      return [];
    }

    return [];
  }

  // ── Test helpers ──
  _addSchedule(id, opts = {}) {
    this.schedules.set(id, {
      id, name: id, enabled: 1, cron: '0 * * * *', limits_json: '{}',
      current_state: 'idle', current_execution_id: null, last_status: 'idle',
      run_count: 0, updated_at: new Date().toISOString(),
      ...opts,
    });
  }

  _setPaused(pipelineId, paused) {
    this.settings.set(`pipeline_${pipelineId}_paused`, paused ? 'true' : 'false');
  }

  _addExecution(id, pipelineId, status, opts = {}) {
    this.executions.set(id, {
      id, pipeline_id: pipelineId, status, state: status,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: ['completed', 'failed', 'stopped'].includes(status) ? new Date().toISOString() : null,
      current_stage: null, current_message: null, progress: 0,
      total_steps: 0, completed_steps: 0, failed_stage: null,
      error_message: null, stack_trace: null, retry_count: 0,
      ...opts,
    });
  }
}

// ── Module mocking ──────────────────────────────────────────────────────────
//
// We override Module._load so that requiring '../src/db/database' returns
// our mock instead of trying to load better-sqlite3. We also mock the
// socket, logger, and health services so the state service can be required
// in isolation.

function setupMocks(db) {
  // Clear the module cache for ALL pipeline-related modules so fresh
  // requires pick up our mocks. We clear by absolute path to be safe.
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');
  const pathsToClear = [
    path.join(rootDir, 'src', 'db', 'database.js'),
    path.join(rootDir, 'src', 'services', 'pipelineStateService.js'),
    path.join(rootDir, 'src', 'services', 'socketService.js'),
    path.join(rootDir, 'src', 'services', 'pipelineLogger.js'),
    path.join(rootDir, 'src', 'services', 'pipelineHealthService.js'),
    path.join(rootDir, 'src', 'utils', 'logger.js'),
    path.join(rootDir, 'src', 'config', 'limits.js'),
  ];
  for (const p of pathsToClear) {
    if (require.cache[p]) delete require.cache[p];
  }

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    // Intercept better-sqlite3 so database.js doesn't crash on require.
    if (request === 'better-sqlite3') {
      return function MockDatabase() { return db; };
    }
    // Intercept the database module so getDb() returns our mock.
    if (request === '../db/database' || request === './database' ||
        request === '../database' || request === '../../db/database' ||
        request.includes('db/database')) {
      return { getDb: () => db };
    }
    // Intercept socketService.
    if (request === '../services/socketService' || request === './socketService' ||
        request.includes('services/socketService')) {
      return { broadcast: () => {} };
    }
    // Intercept pipelineLogger.
    if (request === '../services/pipelineLogger' || request === './pipelineLogger' ||
        request.includes('services/pipelineLogger')) {
      return { log: () => {} };
    }
    // Intercept pipelineHealthService.
    if (request === '../services/pipelineHealthService' || request === './pipelineHealthService' ||
        request.includes('services/pipelineHealthService')) {
      return { recomputeAggregates: () => {} };
    }
    // Intercept logger.
    if (request === '../utils/logger' || request === './logger' ||
        request.includes('utils/logger')) {
      return {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
        db: () => {},
      };
    }
    return originalLoad.apply(this, arguments);
  };

  return () => { Module._load = originalLoad; };
}

// ── Tests ───────────────────────────────────────────────────────────────────

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

  const pipelineState = require('../src/services/pipelineStateService');
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

  const pipelineState = require('../src/services/pipelineStateService');
  pipelineState.forceClearExecution('outreach', 'test');

  assert.equal(db.settings.get('pipeline_outreach_paused'), 'false');

  restore();
});

test('forceClearExecution preserves the pause flag when keepPauseIntent is true', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', true);

  const pipelineState = require('../src/services/pipelineStateService');
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

  const pipelineState = require('../src/services/pipelineStateService');
  pipelineState.forceClearExecution('content', 'test');

  assert.equal(db.settings.get('content_pipeline_lock'), 'false');

  restore();
});

test('canStart returns true for a manual run on a disabled schedule', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach', { enabled: 0 });
  db._setPaused('outreach', false);

  const pipelineState = require('../src/services/pipelineStateService');
  assert.equal(pipelineState.canStart('outreach'), true);

  restore();
});

test('canStart returns false when paused and no force', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', true);

  const pipelineState = require('../src/services/pipelineStateService');
  assert.equal(pipelineState.canStart('outreach'), false);
  assert.equal(pipelineState.canStart('outreach', { force: true }), true);

  restore();
});

test('hasStuckDbRow detects transient-state rows', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../src/services/pipelineStateService');

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

  const pipelineState = require('../src/services/pipelineStateService');

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

test('requestResume on a schedule-level pause (no active execution) clears the pause flag', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach', { last_status: 'paused', current_state: 'paused' });
  db._setPaused('outreach', true);

  const pipelineState = require('../src/services/pipelineStateService');
  const result = pipelineState.requestResume('outreach');

  assert.equal(result.ok, true);
  assert.equal(result.scheduleLevel, true);
  assert.equal(db.settings.get('pipeline_outreach_paused'), 'false');

  restore();
});

test('requestStop on a schedule-level pause (no active execution) sweeps the stuck DB row', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const execId = 'exec-stuck-stop';
  db._addExecution(execId, 'outreach', 'running');

  const pipelineState = require('../src/services/pipelineStateService');
  const result = pipelineState.requestStop('outreach');

  assert.equal(result.ok, true);
  assert.equal(result.stopped, 1);
  assert.equal(result.sweptDb, true);
  assert.equal(result.executionId, execId);
  assert.equal(db.executions.get(execId).status, 'stopped');

  restore();
});

test('createExecution refuses when an active execution already exists', () => {
  const db = new MockDB();
  const restore = setupMocks(db);

  db._addSchedule('outreach');
  db._setPaused('outreach', false);

  const pipelineState = require('../src/services/pipelineStateService');

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

  const pipelineState = require('../src/services/pipelineStateService');

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

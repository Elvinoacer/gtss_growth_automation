/**
 * pipelineMigrations.js — Pipeline scheduling / execution / logging schema.
 *
 * Creates the production-grade pipeline tables:
 *   - pipeline_schedules (+ idempotent column additions for state-tracking
 *     fields like current_state, current_execution_id, last_error,
 *     total_runs, total_failures, consecutive_failures, avg_duration_ms)
 *   - pipeline_executions (one row per pipeline run)
 *   - pipeline_checkpoints (per-stage progress snapshots for resume/retry)
 *   - pipeline_logs (one row per lifecycle / stage / progress log line)
 *   - pipeline_events (job-level event log)
 *   - keyword_groups (saved discovery keyword bundles)
 *   - asset_library / asset_groups / asset_usage_log (asset management)
 *   - audit_log (user & system activity audit trail)
 *   - schema_migrations (named-migration tracking for future use)
 *
 * Every block is wrapped in `try { ... } catch (_) {}` so existing databases
 * that already have these tables / columns simply no-op — identical to the
 * original monolithic database.js behaviour.
 */
"use strict";

function runPipelineMigrations(database) {
  // ── pipeline_schedules table ──────────────────────────────────────────
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_schedules (
        id          TEXT PRIMARY KEY,          -- 'outreach' | 'content'
        name        TEXT NOT NULL,
        description TEXT,
        enabled     INTEGER NOT NULL DEFAULT 0,
        cron        TEXT NOT NULL,             -- standard 5-field cron expression
        limits_json TEXT NOT NULL DEFAULT '{}', -- arbitrary per-pipeline limit bag
        last_run_at DATETIME,
        next_run_at DATETIME,
        last_status TEXT,                       -- 'completed' | 'failed' | 'running'
        run_count   INTEGER NOT NULL DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {
    /* table exists */
  }

  // ── Pipelines overhaul: add production-grade columns & tables (idempotent) ──
  try {
    const scheduleCols = database
      .prepare("PRAGMA table_info(pipeline_schedules)")
      .all()
      .map((c) => c.name);
    const addColIfMissing = (col, def) => {
      if (!scheduleCols.includes(col)) {
        database.exec(
          `ALTER TABLE pipeline_schedules ADD COLUMN ${col} ${def}`,
        );
      }
    };
    addColIfMissing("current_state", "TEXT DEFAULT 'idle'");
    addColIfMissing("current_execution_id", "TEXT");
    addColIfMissing("last_error", "TEXT");
    addColIfMissing("last_success_at", "DATETIME");
    addColIfMissing("last_failure_at", "DATETIME");
    addColIfMissing("total_runs", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("total_failures", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("total_retries", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("avg_duration_ms", "INTEGER");
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_pipeline_schedules_state ON pipeline_schedules(current_state)",
    );
  } catch (_) {}

  // ── pipeline_executions / pipeline_checkpoints / pipeline_logs ─────────
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_executions (
        id              TEXT PRIMARY KEY,
        pipeline_id     TEXT NOT NULL,
        trigger         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        state           TEXT NOT NULL DEFAULT 'idle',
        current_stage   TEXT,
        current_message TEXT,
        progress        INTEGER DEFAULT 0,
        total_steps     INTEGER DEFAULT 0,
        completed_steps INTEGER DEFAULT 0,
        failed_stage    TEXT,
        error_message   TEXT,
        stack_trace     TEXT,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        max_retries     INTEGER NOT NULL DEFAULT 3,
        started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at     DATETIME,
        paused_at       DATETIME,
        resumed_at      DATETIME,
        stopped_at      DATETIME,
        duration_ms     INTEGER,
        metadata_json   TEXT,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_executions_pipeline ON pipeline_executions(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_executions_status ON pipeline_executions(status);
      CREATE INDEX IF NOT EXISTS idx_pipeline_executions_started ON pipeline_executions(started_at DESC);

      CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id    TEXT NOT NULL,
        pipeline_id     TEXT NOT NULL,
        stage           TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempt         INTEGER DEFAULT 1,
        payload_json    TEXT,
        error_message   TEXT,
        duration_ms     INTEGER,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_exec ON pipeline_checkpoints(execution_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_pipeline ON pipeline_checkpoints(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_stage ON pipeline_checkpoints(stage);

      CREATE TABLE IF NOT EXISTS pipeline_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id     TEXT NOT NULL,
        execution_id    TEXT,
        stage           TEXT,
        level           TEXT NOT NULL DEFAULT 'info',
        message         TEXT NOT NULL,
        stack_trace     TEXT,
        context_json    TEXT,
        browser_event   TEXT,
        retry_attempt   INTEGER,
        source          TEXT DEFAULT 'system',
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pipeline ON pipeline_logs(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_logs_execution ON pipeline_logs(execution_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level ON pipeline_logs(level);
      CREATE INDEX IF NOT EXISTS idx_pipeline_logs_stage ON pipeline_logs(stage);
      CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at DESC);
    `);
  } catch (_) {
    /* tables exist */
  }

  // ── pipeline_events / keyword_groups / asset_library / asset_groups ───
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type     TEXT NOT NULL,
        job_id       TEXT,
        stage        TEXT,
        level        TEXT NOT NULL,
        message      TEXT NOT NULL,
        context_json TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_job_id ON pipeline_events(job_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_level ON pipeline_events(level);
      CREATE INDEX IF NOT EXISTS idx_pipeline_events_created ON pipeline_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS keyword_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        keywords TEXT NOT NULL,
        platforms TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS asset_library (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        file_url TEXT NOT NULL,
        media_type TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        tags TEXT,
        times_used INTEGER DEFAULT 0,
        last_used_at DATETIME,
        group_id INTEGER,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_asset_library_media_type ON asset_library(media_type);
      CREATE INDEX IF NOT EXISTS idx_asset_library_times_used ON asset_library(times_used ASC);
      CREATE INDEX IF NOT EXISTS idx_asset_library_group_id ON asset_library(group_id);

      CREATE TABLE IF NOT EXISTS asset_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        label TEXT,
        post_type TEXT DEFAULT 'carousel',
        times_used INTEGER DEFAULT 0,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS asset_usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER REFERENCES asset_library(id),
        post_id INTEGER REFERENCES posts(id),
        used_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        platform TEXT,
        actor TEXT DEFAULT 'system',
        status TEXT,
        summary TEXT NOT NULL,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_activity ON audit_log(activity_type);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_platform ON audit_log(platform);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {
    /* tables exist */
  }
}

module.exports = {
  runPipelineMigrations,
};

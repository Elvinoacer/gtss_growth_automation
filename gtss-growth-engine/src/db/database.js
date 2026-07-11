const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const limits = require("../config/limits");

function resolveDbPath() {
  return path.resolve(process.env.DB_PATH || "./data/gtss.db");
}

function openDatabase() {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, {
    verbose: process.env.NODE_ENV === "development" ? console.log : undefined,
  });

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);

  return db;
}

function initializeSchema(database) {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  database.exec(schema);

  // Safe migrations for existing databases
  try {
    database.exec("ALTER TABLE messages ADD COLUMN snooze_until DATETIME");
  } catch (_) {
    /* column exists */
  }
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN last_error TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN blocked_reason TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN fail_category TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN next_retry_at TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN last_error TEXT");
  } catch (_) {}
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at DATETIME,
        completed_at DATETIME,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS automation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        platform TEXT,
        account TEXT,
        action_type TEXT,
        target TEXT,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        status TEXT NOT NULL,
        warning_detected INTEGER DEFAULT 0,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS action_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        message_id INTEGER REFERENCES messages(id),
        lead_id INTEGER REFERENCES leads(id),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {
    /* tables exist */
  }

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS image_gen_jobs (
        id           TEXT PRIMARY KEY,
        meta_prompt  TEXT NOT NULL,
        gen_prompt   TEXT,
        status       TEXT DEFAULT 'pending',
        file_path    TEXT,
        file_name    TEXT,
        error        TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
    `);
  } catch (_) {
    /* table exists */
  }

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ig_warmup_sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        current_step INTEGER DEFAULT 0,
        story_views_count INTEGER DEFAULT 0,
        post_likes_count INTEGER DEFAULT 0,
        comments_count INTEGER DEFAULT 0,
        last_action_at DATETIME,
        next_action_at DATETIME,
        next_step TEXT,
        next_step_after DATETIME,
        attempt_count INTEGER DEFAULT 0,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ig_warmup_sequences_lead ON ig_warmup_sequences(lead_id);

      CREATE TABLE IF NOT EXISTS ig_follow_tracker (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        username TEXT,
        status TEXT DEFAULT 'following',
        followed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        unfollowed_at DATETIME,
        eligible_for_unfollow INTEGER DEFAULT 1,
        follow_back_at DATETIME,
        follow_source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_lead ON ig_follow_tracker(lead_id);
      CREATE INDEX IF NOT EXISTS idx_ig_follow_tracker_username ON ig_follow_tracker(username);

      CREATE TABLE IF NOT EXISTS ig_discovery_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ig_username TEXT NOT NULL,
        source TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ig_discovery_queue_username ON ig_discovery_queue(ig_username);
    `);
  } catch (_) {
    /* tables exist */
  }

  // Pipeline migrations
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger     TEXT NOT NULL,
        mode        TEXT NOT NULL,
        status      TEXT DEFAULT 'running',
        stages_json TEXT,
        started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME
      );
    `);
  } catch (_) {
    /* table exists */
  }
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN x_handle TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_username TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_follower_count INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_following_count INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_post_count INTEGER");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_is_business INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_business_category TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_has_email INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_has_phone INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_bio TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE discovery_runs ADD COLUMN pipeline_run_id INTEGER REFERENCES pipeline_runs(id)",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN generated_by TEXT DEFAULT 'ai'",
    );
  } catch (_) {}

  // Instagram warmup safe migrations
  try {
    database.exec("ALTER TABLE ig_warmup_sequences ADD COLUMN next_step TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN next_step_after DATETIME",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN attempt_count INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_warmup_sequences ADD COLUMN completed_at DATETIME",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN ig_follow_back_at DATETIME");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE leads ADD COLUMN ig_warmup_status TEXT DEFAULT 'pending'",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN eligible_for_unfollow INTEGER DEFAULT 1",
    );
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_status TEXT GENERATED ALWAYS AS (status)",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE messages ADD COLUMN action_type TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE messages ADD COLUMN ig_is_message_request INTEGER DEFAULT 0",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE touchpoints ADD COLUMN source TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE touchpoints ADD COLUMN created_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE leads ADD COLUMN replied_at DATETIME");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_back_at DATETIME",
    );
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_post_url TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_post_type TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN ig_story_expires_at DATETIME");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN media_paths TEXT");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE posts ADD COLUMN location_tag TEXT");
  } catch (_) {}
  try {
    // Per-platform captions: JSON map of { platform: captionString }.
    // The content pipeline writes one caption per platform here, and the
    // publisher reads the platform-specific caption instead of re-using
    // the primary platform's caption (and truncating it for shorter-limit
    // platforms like X).
    database.exec("ALTER TABLE posts ADD COLUMN captions_json TEXT");
  } catch (_) {}
  try {
    database.exec(
      "ALTER TABLE ig_follow_tracker ADD COLUMN follow_source TEXT",
    );
  } catch (_) {}

  // ── Asset grouping migrations ─────────────────────────────────────────
  // Add group_id + position columns to existing asset_library rows so the
  // user can group uploaded images into multi-image posts / carousels.
  try {
    database.exec("ALTER TABLE asset_library ADD COLUMN group_id INTEGER");
  } catch (_) {}
  try {
    database.exec("ALTER TABLE asset_library ADD COLUMN position INTEGER DEFAULT 0");
  } catch (_) {}
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS asset_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        label TEXT,
        post_type TEXT DEFAULT 'carousel',
        times_used INTEGER DEFAULT 0,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (_) {}
  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_asset_library_group_id ON asset_library(group_id)");
  } catch (_) {}

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        processed_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {}

  // Campaign schema initialization
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS connection_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, lead_id)
      );

      CREATE TABLE IF NOT EXISTS dm_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        status TEXT DEFAULT 'pending',
        scheduled_at DATETIME,
        sent_at DATETIME,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(campaign_id, lead_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS campaign_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_connection_jobs_campaign_id ON connection_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_connection_jobs_lead_id ON connection_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_campaign_id ON dm_jobs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_lead_id ON dm_jobs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_dm_jobs_message_id ON dm_jobs(message_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id ON campaign_events(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_events_lead_id ON campaign_events(lead_id);
    `);
  } catch (_) {}

  try {
    const cols = database
      .prepare("PRAGMA table_info(campaigns)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("name")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN name TEXT");
    }
    if (!cols.includes("platform")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN platform TEXT");
    }
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE campaigns ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE campaigns
      SET name = COALESCE(NULLIF(name, ''), 'Untitled Campaign ' || id),
          platform = COALESCE(NULLIF(platform, ''), 'linkedin'),
          created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  try {
    const cols = database
      .prepare("PRAGMA table_info(connection_jobs)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE connection_jobs ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE connection_jobs ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE connection_jobs
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  try {
    const cols = database
      .prepare("PRAGMA table_info(dm_jobs)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("scheduled_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN scheduled_at DATETIME");
    }
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN created_at DATETIME");
    }
    if (!cols.includes("updated_at")) {
      database.exec("ALTER TABLE dm_jobs ADD COLUMN updated_at DATETIME");
    }
    database.exec(`
      UPDATE dm_jobs
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  try {
    const cols = database
      .prepare("PRAGMA table_info(campaign_events)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("created_at")) {
      database.exec("ALTER TABLE campaign_events ADD COLUMN created_at DATETIME");
    }
    database.exec(`
      UPDATE campaign_events
      SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)
    `);
  } catch (_) {}

  try {
    const cols = database
      .prepare("PRAGMA table_info(daily_actions)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("campaign_id")) {
      database.exec(
        "ALTER TABLE daily_actions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)",
      );
    }
    if (!cols.includes("reason")) {
      database.exec("ALTER TABLE daily_actions ADD COLUMN reason TEXT");
    }
  } catch (_) {}

  try {
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_daily_actions_campaign_id ON daily_actions(campaign_id)",
    );
  } catch (_) {}

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

  seedDefaultSettings(database);
  seedDefaultPipelineSchedules(database);
}

function seedDefaultSettings(database) {
  const row = database
    .prepare("SELECT value FROM settings WHERE key = 'daily_limits'")
    .get();

  if (!row) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('daily_limits', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run(JSON.stringify(limits));
  }

  const queueLockRow = database
    .prepare("SELECT value FROM settings WHERE key = 'campaign_queue_lock'")
    .get();
  if (!queueLockRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('campaign_queue_lock', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("false");
  }

  // Seed default outreach modes
  const xOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'x_outreach_mode'")
    .get();
  if (!xOutreachModeRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('x_outreach_mode', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("follow_first");
  }

  const linkedinOutreachModeRow = database
    .prepare("SELECT value FROM settings WHERE key = 'linkedin_outreach_mode'")
    .get();
  if (!linkedinOutreachModeRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('linkedin_outreach_mode', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("connect_first");
  }

  // Seed content pipeline overlap lock
  const contentPipelineLockRow = database
    .prepare("SELECT value FROM settings WHERE key = 'content_pipeline_lock'")
    .get();
  if (!contentPipelineLockRow) {
    database
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('content_pipeline_lock', ?) ON CONFLICT(key) DO NOTHING",
      )
      .run("false");
  }

  const defaults = {
    retry_max_attempts: "5",
    retry_delay_preset: "conservative",
    pipeline_outreach_paused: "false",
    pipeline_content_paused: "false",
    pipeline_dm_check_paused: "false",
    pipeline_mass_follow_paused: "false",
    pipeline_tiktok_mass_follow_paused: "false",
    pipeline_discovery_paused: "false",
    content_asset_source: "ai",
    content_library_media_type: "image",
    warmup_min_follow_to_story_hours: "24",
    warmup_max_follow_to_story_hours: "48",
    warmup_min_story_to_like_hours: "12",
    warmup_max_story_to_like_hours: "24",
    warmup_min_like_to_dm_hours: "24",
    warmup_max_like_to_dm_hours: "48",
    fast_warmup_enabled: "0",
    auto_warmup_on_qualify: "1",
    unfollow_after_days: "30",
    unfollow_pending_after_days: "14",
    max_following_ratio: "1.5",
    discovery_max_per_hashtag: "30",
    discovery_min_followers: "100",
    discovery_max_followers: "100000",
    ig_selector_version: "1",
  };

  const stmt = database.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  Object.entries(defaults).forEach(([key, value]) => stmt.run(key, value));
}

function seedDefaultPipelineSchedules(database) {
  // Outreach pipeline — disabled by default until user turns it on
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'outreach',
      'Lead Outreach Pipeline',
      'Discovery → Qualification → Message Generation → DM Send',
      0,
      '0 8 * * *',
      '{"platforms": ["linkedin", "x"], "max_leads_per_keyword": 10, "max_dms_per_run": 20, "max_connections_per_run": 15}'
    )
  `).run();

  // Content pipeline — disabled by default until user configures topic/platforms
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'content',
      'Auto-Content Posting Pipeline',
      'Gemini image generation → Caption generation → Multi-platform post',
      0,
      '0 9 * * *',
      '{"platforms": ["instagram", "linkedin"], "topic": "", "style": "photorealistic", "max_posts_per_run": 1}'
    )
  `).run();

  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'dm_check',
      'DM Inbox Checker',
      'Scans connected social inboxes for new replies',
      1,
      '*/30 * * * *',
      '{"active_hours_start": 8, "active_hours_end": 22, "timezone": "Africa/Nairobi", "platforms": ["instagram", "linkedin", "x", "facebook"], "prompt": ""}'
    )
  `).run();

  // Mass-Follow pipeline — disabled by default until the user adds targets
  // and configures platforms. Cron runs every 30 minutes; each run pulls a
  // batch of pending mass_follow_targets rows, follows them via the platform
  // adapter (which respects per-platform active windows, daily limits, and
  // human-like delays), and writes a summary back to the pipeline logs.
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'mass_follow',
      'Mass-Follow Pipeline',
      'Bulk-follow target accounts across X, LinkedIn, Facebook, Instagram, and TikTok with human-like scheduling',
      0,
      '*/30 * * * *',
      '{"platforms": ["instagram", "x", "linkedin", "facebook", "tiktok"], "max_follows_per_run": 20, "follow_interval_min_seconds": 40, "follow_interval_max_seconds": 110, "respect_active_window": true, "skip_already_following": true, "max_retries_per_target": 3}'
    )
  `).run();

  // TikTok Mass-Follow pipeline — a dedicated, search-driven pipeline that
  // navigates to TikTok's /search/user page, scrapes the visible user cards,
  // and clicks Follow directly on each card (data-e2e="follow-back"). This
  // is independent of the generic mass_follow pipeline (which operates on
  // pre-populated targets and navigates to each profile). The user sets:
  //   - search_query: the TikTok user-search query (e.g. "restaurant owners")
  //   - max_follows_per_run: the per-run follow limit (user-settable)
  // Disabled by default until the user configures a search query.
  database.prepare(`
    INSERT OR IGNORE INTO pipeline_schedules
      (id, name, description, enabled, cron, limits_json)
    VALUES (
      'tiktok_mass_follow',
      'TikTok Mass-Follow Pipeline',
      'Search TikTok for users by query and follow them directly from the search results page',
      0,
      '*/30 * * * *',
      '{"search_query": "restaurant owners", "max_follows_per_run": 20, "follow_interval_min_seconds": 40, "follow_interval_max_seconds": 110, "max_scrolls": 3, "respect_active_window": true}'
    )
  `).run();

  // DISABLED — see src/pipeline/tiktokMassFollowPipeline.js header comment
  // and RUNNERS.tiktok_mass_follow in src/jobs/pipelineScheduler.js, which
  // now refuses to execute this pipeline unconditionally. This forces the
  // row to enabled=0 + paused on every startup (not just INSERT OR IGNORE
  // on first seed) so an existing install with the row already enabled from
  // before this change gets disabled too, and cron.unregister() drops any
  // already-registered schedule for it.
  database.prepare(`
    UPDATE pipeline_schedules SET enabled = 0, next_run_at = NULL
    WHERE id = 'tiktok_mass_follow'
  `).run();
  database.prepare(`
    INSERT INTO settings (key, value) VALUES ('pipeline_tiktok_mass_follow_paused', 'true')
    ON CONFLICT(key) DO UPDATE SET value = 'true'
  `).run();
}

const db = openDatabase();

function getDailyActionCount(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM daily_actions
       WHERE platform = ?
         AND action_type = ?
         AND DATE(performed_at) = DATE('now', 'localtime')`,
    )
    .get(platform, normalizedActionType);

  return row.count;
}

function isWithinLimit(platform, actionType) {
  const normalizedActionType = normalizeActionType(actionType);
  const platformLimits = getDailyLimits()[platform] || {};

  let limit;
  if (typeof platformLimits[normalizedActionType] === "number") {
    limit = platformLimits[normalizedActionType];
  } else if (
    limits[platform] &&
    typeof limits[platform][normalizedActionType] === "number"
  ) {
    limit = limits[platform][normalizedActionType];
  }

  if (typeof limit !== "number") {
    // Emit a visible warning; use a conservative default of 5 instead of blocking
    console.warn(
      `[LIMITS] No limit configured for ${platform}.${normalizedActionType} — defaulting to 5`,
    );
    return getDailyActionCount(platform, normalizedActionType) < 5;
  }

  return getDailyActionCount(platform, normalizedActionType) < limit;
}

function getDailyLimits() {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'daily_limits'")
    .get();

  if (!row || !row.value) {
    return {};
  }

  try {
    return JSON.parse(row.value);
  } catch (_) {
    return {};
  }
}

function normalizeActionType(actionType) {
  const aliases = {
    connect: "connections",
    connection: "connections",
    dm: "dms",
    direct_message: "dms",
    follow: "follows",
    like: "likes",
    instagram_dm: "dms",
    instagram_follow: "follows",
    instagram_like: "likes",
  };

  return aliases[actionType] || actionType;
}

function increment_action_count(
  platform,
  actionType,
  leadId = null,
  outcome = "sent",
  reason = null,
) {
  const normalizedActionType = normalizeActionType(actionType);
  const insert = db.prepare(
    `INSERT INTO daily_actions (platform, action_type, lead_id, outcome, reason, performed_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );
  insert.run(platform, normalizedActionType, leadId, outcome, reason);
}

function getDb() {
  return db;
}

function initializeDatabase() {
  initializeSchema(db);
  // Migrate keywords.json -> context store (runs once, skipped if already migrated)
  migrateKeywordsToContextStore();
}

function migrateKeywordsToContextStore() {
  try {
    const db = getDb();
    // Check if already migrated
    const existing = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'ctx_discovery_keywords'",
      )
      .get();
    if (existing) return; // Already done

    const fs = require("fs");
    const path = require("path");
    const filePath = path.resolve("./src/config/keywords.json");
    if (!fs.existsSync(filePath)) return;

    const fileContent = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const keywords = fileContent.keywords || [];
    const maxPerKeyword = fileContent.maxLeadsPerKeyword || 10;

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('ctx_discovery_keywords', ?) ON CONFLICT(key) DO NOTHING",
    ).run(JSON.stringify(keywords));

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('ctx_discovery_max_per_keyword', ?) ON CONFLICT(key) DO NOTHING",
    ).run(String(maxPerKeyword));

    const logger = require("../utils/logger");
    logger.info(
      "DB",
      `Migrated ${keywords.length} keywords from keywords.json to context store`,
    );
  } catch (err) {
    // Non-fatal - log and continue
    console.warn("[DB] keywords.json migration skipped:", err.message);
  }
}

module.exports = {
  db,
  getDb,
  initializeDatabase,
  getDailyActionCount,
  getDailyLimits,
  isWithinLimit,
  normalizeActionType,
  increment_action_count,
};

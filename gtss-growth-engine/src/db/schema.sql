CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  name TEXT,
  role TEXT,
  company TEXT,
  location TEXT,
  profile_url TEXT UNIQUE,
  x_handle TEXT,
  ig_username TEXT,
  ig_follower_count INTEGER,
  ig_following_count INTEGER,
  ig_post_count INTEGER,
  ig_is_business INTEGER DEFAULT 0,
  ig_business_category TEXT,
  ig_has_email INTEGER DEFAULT 0,
  ig_has_phone INTEGER DEFAULT 0,
  ig_bio TEXT,
  ig_follow_back_at DATETIME,
  ig_warmup_status TEXT DEFAULT 'pending',
  website TEXT,
  source_keyword TEXT,
  lead_score INTEGER DEFAULT NULL,
  score_reason TEXT,
  status TEXT DEFAULT 'discovered',
  -- status values: discovered, qualified, deprioritized, messaged, replied, meeting_booked, converted, lost
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  type TEXT NOT NULL, -- connection, dm, follow, like, comment, reply
  platform TEXT,
  message_id INTEGER REFERENCES messages(id),
  outcome TEXT, -- sent, failed, skipped, not_connected, premium_required, session_required, unknown, limit_reached
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  platform TEXT,
  body TEXT,
  variant TEXT, -- A or B
  approved_by TEXT,
  approved_at DATETIME,
  sent_at DATETIME,
  is_follow_up INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, approved, blocked, sent, skipped
  snooze_until DATETIME,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  blocked_reason TEXT,
  fail_category TEXT,
  ig_is_message_request INTEGER DEFAULT 0,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platforms TEXT, -- JSON array e.g. ["linkedin","x"]
  body TEXT,
  captions_json TEXT, -- JSON map of { platform: caption } so the publisher can use a per-platform caption
  media_path TEXT,
  media_paths TEXT,
  location_tag TEXT,
  scheduled_at DATETIME,
  published_at DATETIME,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  status TEXT DEFAULT 'scheduled', -- scheduled, published, failed, draft
  ig_post_url TEXT,
  ig_post_type TEXT DEFAULT 'feed',
  ig_story_expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT UNIQUE,
  cookie_blob TEXT, -- AES-256 encrypted JSON
  last_active DATETIME,
  is_valid INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT,
  action_type TEXT,
  performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  lead_id INTEGER REFERENCES leads(id),
  outcome TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT,
  platforms TEXT,
  leads_found INTEGER DEFAULT 0,
  status TEXT DEFAULT 'completed',
  run_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS image_gen_jobs (
  id TEXT PRIMARY KEY,
  meta_prompt TEXT NOT NULL,
  gen_prompt TEXT,
  status TEXT DEFAULT 'pending',
  file_path TEXT,
  file_name TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

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

CREATE TABLE IF NOT EXISTS pipeline_schedules (
  id          TEXT PRIMARY KEY,          -- 'outreach' | 'content' | 'dm_check'
  name        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0,
  cron        TEXT NOT NULL,             -- standard 5-field cron expression
  limits_json TEXT NOT NULL DEFAULT '{}', -- arbitrary per-pipeline limit bag
  last_run_at DATETIME,
  next_run_at DATETIME,
  last_status TEXT,                       -- 'completed' | 'failed' | 'running' | 'paused' | 'stopped' | 'idle'
  run_count   INTEGER NOT NULL DEFAULT 0,
  -- ── Production-grade health & state columns (added in pipelines overhaul) ──
  current_state       TEXT DEFAULT 'idle',  -- idle | scheduled | running | paused | resuming | stopping | stopped | completed | failed | retrying
  current_execution_id TEXT,                -- FK to pipeline_executions.id (text UUID) for the active execution, if any
  last_error          TEXT,
  last_success_at     DATETIME,
  last_failure_at     DATETIME,
  total_runs          INTEGER NOT NULL DEFAULT 0,
  total_failures      INTEGER NOT NULL DEFAULT 0,
  total_retries       INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms     INTEGER,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── Per-execution lifecycle tracking (covers all 3 pipelines: outreach, content, dm_check) ──
CREATE TABLE IF NOT EXISTS pipeline_executions (
  id              TEXT PRIMARY KEY,         -- UUID
  pipeline_id     TEXT NOT NULL,            -- 'outreach' | 'content' | 'dm_check'
  trigger         TEXT NOT NULL,            -- 'cron' | 'manual' | 'api' | 'retry' | 'resume'
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | paused | resuming | stopping | stopped | completed | failed | retrying
  state           TEXT NOT NULL DEFAULT 'idle',     -- mirror of status (kept for UI compatibility)
  current_stage   TEXT,
  current_message TEXT,
  progress        INTEGER DEFAULT 0,        -- 0..100
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
  metadata_json   TEXT,                     -- arbitrary payload snapshot (limits, keywords, platforms, etc.)
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_executions_pipeline ON pipeline_executions(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_executions_status ON pipeline_executions(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_executions_started ON pipeline_executions(started_at DESC);

-- ── Per-stage checkpoints (resume-from-last-success support) ──
CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id    TEXT NOT NULL,
  pipeline_id     TEXT NOT NULL,
  stage           TEXT NOT NULL,
  status          TEXT NOT NULL,           -- 'completed' | 'failed' | 'skipped'
  attempt         INTEGER DEFAULT 1,
  payload_json    TEXT,                    -- stage result snapshot (counts, post_id, etc.)
  error_message   TEXT,
  duration_ms     INTEGER,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_exec ON pipeline_checkpoints(execution_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_pipeline ON pipeline_checkpoints(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_stage ON pipeline_checkpoints(stage);

-- ── Structured searchable logs (extends pipeline_events with stage/level/search fields) ──
CREATE TABLE IF NOT EXISTS pipeline_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id     TEXT NOT NULL,
  execution_id    TEXT,
  stage           TEXT,
  level           TEXT NOT NULL DEFAULT 'info',  -- debug | info | warn | error | retry | success
  message         TEXT NOT NULL,
  stack_trace     TEXT,
  context_json    TEXT,
  browser_event   TEXT,                    -- optional: e.g. 'navigation', 'click', 'timeout', 'captcha'
  retry_attempt   INTEGER,
  source          TEXT DEFAULT 'system',   -- 'system' | 'browser' | 'user' | 'scheduler'
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_pipeline ON pipeline_logs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_execution ON pipeline_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_level ON pipeline_logs(level);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_stage ON pipeline_logs(stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type     TEXT NOT NULL,  -- 'outreach' | 'content' | 'dm_check' | 'discovery' | 'scheduled_post' | 'campaign_dm' | 'campaign_connection'
  job_id       TEXT,           -- pipeline run ID or cron job UUID
  stage        TEXT,
  level        TEXT NOT NULL,  -- 'info' | 'warn' | 'error' | 'retry'
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
  -- Asset grouping: an asset may belong to one group (e.g. a carousel
  -- set or a multi-image post). group_id + position let the user
  -- decide which images belong together as a single post and in what
  -- order. NULL group_id = standalone asset (legacy behaviour).
  group_id INTEGER REFERENCES asset_groups(id) ON DELETE SET NULL,
  position INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_asset_library_media_type ON asset_library(media_type);
CREATE INDEX IF NOT EXISTS idx_asset_library_times_used ON asset_library(times_used ASC);
CREATE TABLE IF NOT EXISTS asset_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  label TEXT,
  -- post_type hints the publisher about how to use the group:
  --   'carousel'  → multi-image post (Instagram carousel, etc.)
  --   'video'     → group contains a video (and optional thumbnail)
  --   'single'    → group has one asset (treat as a normal single post)
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

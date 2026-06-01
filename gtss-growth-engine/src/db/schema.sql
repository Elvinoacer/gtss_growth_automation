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
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platforms TEXT, -- JSON array e.g. ["linkedin","x"]
  body TEXT,
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
  outcome TEXT
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


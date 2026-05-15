CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  name TEXT,
  role TEXT,
  company TEXT,
  location TEXT,
  profile_url TEXT UNIQUE,
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
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platforms TEXT, -- JSON array e.g. ["linkedin","x"]
  body TEXT,
  media_path TEXT,
  scheduled_at DATETIME,
  published_at DATETIME,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  status TEXT DEFAULT 'scheduled', -- scheduled, published, failed, draft
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

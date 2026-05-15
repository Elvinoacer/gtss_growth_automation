const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtss-linkedin-mode-test-'));
process.env.DB_PATH = path.join(root, 'gtss.db');
process.env.ENCRYPTION_KEY = 'test-key';
process.env.LINKEDIN_OUTREACH_MODE = 'dm_only';

const { getDb } = require('../src/db/database');
const { determineActionType, getLinkedInOutreachMode } = require('../src/automation/executor');

test('LINKEDIN_OUTREACH_MODE env overrides stale DB setting', () => {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('linkedin_outreach_mode', 'connect_first') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run();

  assert.equal(getLinkedInOutreachMode(), 'dm_only');
  assert.equal(determineActionType({
    platform: 'linkedin',
    is_follow_up: 0,
    lead_id: 123
  }), 'dm');
});

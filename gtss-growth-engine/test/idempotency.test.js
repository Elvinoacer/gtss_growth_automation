const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtss-idempotency-test-'));
process.env.DB_PATH = path.join(root, 'gtss.db');
process.env.ENCRYPTION_KEY = 'test-key';
process.env.ACTION_IDEMPOTENCY_TTL_HOURS = '168';

const {
  createActionFingerprint,
  reserveAction,
  releaseActionFingerprint
} = require('../src/automation/idempotency');

test('action fingerprints are stable for equivalent targets', () => {
  const first = createActionFingerprint({
    platform: 'linkedin',
    profile_url: 'https://www.linkedin.com/in/example/'
  }, 'dm');
  const second = createActionFingerprint({
    platform: 'linkedin',
    profile_url: 'https://www.linkedin.com/in/example'
  }, 'dms');

  assert.equal(first, second);
});

test('idempotency reservations prevent duplicate actions until released', () => {
  const action = {
    platform: 'linkedin',
    profile_url: 'https://www.linkedin.com/in/example',
    message_id: null,
    lead_id: null
  };

  const first = reserveAction(action, 'dm');
  assert.equal(first.reserved, true);

  const duplicate = reserveAction(action, 'dm');
  assert.equal(duplicate.reserved, false);
  assert.match(duplicate.reason, /Duplicate action/);

  releaseActionFingerprint(first.fingerprint);
  const afterRelease = reserveAction(action, 'dm');
  assert.equal(afterRelease.reserved, true);
  releaseActionFingerprint(afterRelease.fingerprint);
});

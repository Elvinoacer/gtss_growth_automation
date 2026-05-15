const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtss-browser-test-'));
process.env.DB_PATH = path.join(root, 'gtss.db');
process.env.ENCRYPTION_KEY = 'test-key';
process.env.AUTOMATION_LOCKS_DIR = path.join(root, 'locks');
process.env.ALLOW_HEADLESS_SOCIAL = 'false';

const {
  acquireBrowserLock,
  releaseBrowserLock,
  normalizeHeadless
} = require('../src/automation/browserBase');

test('browser locks block concurrent use of the same profile', () => {
  const lock = acquireBrowserLock('linkedin', 'persistent', '/tmp/profile-a');

  assert.throws(
    () => acquireBrowserLock('linkedin', 'persistent', '/tmp/profile-a'),
    /already in use/
  );

  releaseBrowserLock(lock);
  const nextLock = acquireBrowserLock('linkedin', 'persistent', '/tmp/profile-a');
  releaseBrowserLock(nextLock);
});

test('stale browser locks are cleaned up', () => {
  fs.mkdirSync(process.env.AUTOMATION_LOCKS_DIR, { recursive: true });
  const lockFile = path.join(process.env.AUTOMATION_LOCKS_DIR, 'linkedin-persistent-tmp-profile-b.lock');
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 99999999,
    platform: 'linkedin',
    mode: 'persistent',
    target: '/tmp/profile-b'
  }));

  const lock = acquireBrowserLock('linkedin', 'persistent', '/tmp/profile-b');
  assert.equal(lock.filePath, lockFile);
  releaseBrowserLock(lock);
});

test('headless is disabled for social platforms unless explicitly allowed', () => {
  process.env.ALLOW_HEADLESS_SOCIAL = 'false';
  assert.equal(normalizeHeadless('linkedin', true), false);
  assert.equal(normalizeHeadless('local', true), true);

  process.env.ALLOW_HEADLESS_SOCIAL = 'true';
  assert.equal(normalizeHeadless('linkedin', true), true);
});

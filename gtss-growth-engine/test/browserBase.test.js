const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-browser-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";
process.env.AUTOMATION_LOCKS_DIR = path.join(root, "locks");
process.env.ALLOW_HEADLESS_SOCIAL = "false";

const {
  acquireBrowserLock,
  getBrowserMode,
  releaseBrowserLock,
  normalizeHeadless,
} = require("../src/automation/browserBase");

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  Object.entries(snapshot).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

test("browser locks block concurrent use of the same profile", () => {
  const lock = acquireBrowserLock("linkedin", "persistent", "/tmp/profile-a");

  assert.throws(
    () => acquireBrowserLock("linkedin", "persistent", "/tmp/profile-a"),
    /already in use/,
  );

  releaseBrowserLock(lock);
  const nextLock = acquireBrowserLock(
    "linkedin",
    "persistent",
    "/tmp/profile-a",
  );
  releaseBrowserLock(nextLock);
});

test("stale browser locks are cleaned up", () => {
  fs.mkdirSync(process.env.AUTOMATION_LOCKS_DIR, { recursive: true });
  const lockFile = path.join(
    process.env.AUTOMATION_LOCKS_DIR,
    "linkedin-persistent-tmp-profile-b.lock",
  );
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 99999999,
      platform: "linkedin",
      mode: "persistent",
      target: "/tmp/profile-b",
    }),
  );

  const lock = acquireBrowserLock("linkedin", "persistent", "/tmp/profile-b");
  assert.equal(lock.filePath, lockFile);
  releaseBrowserLock(lock);
});

test("headless is disabled for social platforms unless explicitly allowed", () => {
  process.env.ALLOW_HEADLESS_SOCIAL = "false";
  assert.equal(normalizeHeadless("linkedin", true), false);
  assert.equal(normalizeHeadless("local", true), true);

  process.env.ALLOW_HEADLESS_SOCIAL = "true";
  assert.equal(normalizeHeadless("linkedin", true), true);
});

test("shared CDP takes precedence over persistent browser mode for social platforms", () => {
  const snapshot = snapshotEnv([
    "LINKEDIN_CDP_ENDPOINT",
    "X_CDP_ENDPOINT",
    "FACEBOOK_CDP_ENDPOINT",
    "INSTAGRAM_CDP_ENDPOINT",
    "BROWSER_MODE",
  ]);

  process.env.LINKEDIN_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.X_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.FACEBOOK_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.INSTAGRAM_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.BROWSER_MODE = "persistent";

  assert.equal(getBrowserMode("linkedin"), "cdp");
  assert.equal(getBrowserMode("x"), "cdp");
  assert.equal(getBrowserMode("facebook"), "cdp");
  assert.equal(getBrowserMode("instagram"), "cdp");
  assert.equal(getBrowserMode("x", { mode: "persistent" }), "cdp");
  assert.equal(
    getBrowserMode("facebook", { userDataDir: "/tmp/custom-profile" }),
    "cdp",
  );
  assert.equal(getBrowserMode("local"), "persistent");

  restoreEnv(snapshot);
});

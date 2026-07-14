/**
 * followAccount tests.
 *
 * Verifies:
 *  - action-block detection (body-text scan)
 *  - already-following state detection (button:has-text("Following"))
 *  - pending-request state detection (button:has-text("Requested"))
 *  - successful follow with popup Confirm handling + DB tracker write
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { getDb, instagram, createMockPage } = require("./_helpers");

test("followAccount detects action blocks successfully", async () => {
  const blockedPage = createMockPage({
    url: "https://www.instagram.com/restricted_account/",
    bodyText: "Try again later. This action limit is restricted.",
  });

  const result = await instagram.followAccount(blockedPage, {
    username: "restricted_account",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Instagram action block detected/);

  // Clean up DB state to prevent test interference
  const { getDb } = require("../../src/db/database");
  getDb().prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
});

test("followAccount identifies Already Following state", async () => {
  const followingPage = createMockPage({
    url: "https://www.instagram.com/already_following/",
    visibleSelectors: ['button:has-text("Following")'],
  });

  const result = await instagram.followAccount(followingPage, {
    username: "already_following",
  });
  assert.equal(result.success, true);
  assert.equal(result.alreadyFollowing, true);
});

test("followAccount identifies Requested state", async () => {
  const pendingPage = createMockPage({
    url: "https://www.instagram.com/pending_request/",
    visibleSelectors: ['button:has-text("Requested")'],
  });

  const result = await instagram.followAccount(pendingPage, {
    username: "pending_request",
  });
  assert.equal(result.success, true);
  assert.equal(result.requestPending, true);
});

test("followAccount handles successful follow and handles popup confirm", async () => {
  // Clear any existing database entries for clean testing
  const db = getDb();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();

  const followPage = createMockPage({
    url: "https://www.instagram.com/fresh_user/",
    visibleSelectors: [
      'button:has-text("Follow")',
      'button:has-text("Confirm")', // Dialog confirm selector
    ],
  });

  const result = await instagram.followAccount(followPage, {
    username: "fresh_user",
  });
  assert.equal(result.success, true);

  // Click count checks: clicked "Follow" button and "Confirm" button
  assert.ok(followPage.clicks.includes('button:has-text("Follow")'));
  assert.ok(followPage.clicks.includes('button:has-text("Confirm")'));

  // Database tracking verification
  const lead = db
    .prepare("SELECT * FROM leads WHERE ig_username = ?")
    .get("fresh_user");
  assert.ok(lead);
  assert.equal(lead.platform, "instagram");

  const tracker = db
    .prepare("SELECT * FROM ig_follow_tracker WHERE lead_id = ?")
    .get(lead.id);
  assert.ok(tracker);
  assert.equal(tracker.username, "fresh_user");
  assert.equal(tracker.status, "following");
});

/**
 * unfollowAccount tests.
 *
 * Verifies:
 *  - not-following state detection (no Following button visible)
 *  - successful unfollow with popup confirm + DB tracker status update
 *    (status flips from "following" → "unfollowed", unfollowed_at is set)
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { getDb, instagram, createMockPage } = require("./_helpers");

test("unfollowAccount identifies Not Following state", async () => {
  const unfollowPage = createMockPage({
    url: "https://www.instagram.com/not_following/",
    visibleSelectors: ['button:has-text("Follow")'], // Only follow button visible
  });

  const result = await instagram.unfollowAccount(unfollowPage, {
    username: "not_following",
  });
  assert.equal(result.success, true);
  assert.equal(result.notFollowing, true);
});

test("unfollowAccount executes unfollow with popup confirm and database update", async () => {
  const db = getDb();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM touchpoints").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM leads").run();

  // Make sure a following record exists in the tracker
  let lead = db
    .prepare("SELECT id FROM leads WHERE ig_username = ?")
    .get("fresh_user");
  if (!lead) {
    const res = db
      .prepare(
        "INSERT INTO leads (platform, ig_username, profile_url) VALUES ('instagram', 'fresh_user', 'https://instagram.com/fresh_user')",
      )
      .run();
    lead = { id: res.lastInsertRowid };
  }

  db.prepare(
    "INSERT INTO ig_follow_tracker (lead_id, username, status) VALUES (?, 'fresh_user', 'following')",
  ).run(lead.id);

  const unfollowPage = createMockPage({
    url: "https://www.instagram.com/fresh_user/",
    visibleSelectors: [
      'button:has-text("Following")',
      'button:has-text("Unfollow")', // Confirmation confirm button
    ],
  });

  const result = await instagram.unfollowAccount(unfollowPage, {
    username: "fresh_user",
  });
  assert.equal(result.success, true);

  // Click verification
  assert.ok(unfollowPage.clicks.includes('button:has-text("Following")'));
  assert.ok(unfollowPage.clicks.includes('button:has-text("Unfollow")'));

  // Database verification: entry status updated to "unfollowed"
  const tracker = db
    .prepare("SELECT * FROM ig_follow_tracker WHERE lead_id = ?")
    .get(lead.id);
  assert.ok(tracker);
  assert.equal(tracker.status, "unfollowed");
  assert.ok(tracker.unfollowed_at);
});

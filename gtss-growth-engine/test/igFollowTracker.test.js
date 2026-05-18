const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = "./data/test_instagram.db";

const { getDb } = require("../src/db/database");
const igFollowTracker = require("../src/services/igFollowTracker");

test("igFollowTracker - getFollowingCount, getUnfollowEligible, markUnfollowEligible, getFollowBackRate, isFollowing, getFollowsBySource", () => {
  const db = getDb();

  // Clean tables
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  // 1. Insert dummy leads
  const lead1 = db.prepare(`
    INSERT INTO leads (platform, name, ig_username, profile_url, source_keyword, status)
    VALUES ('instagram', 'Lead One', 'lead_one', 'https://instagram.com/lead_one/', 'competitor_followers:competitor1', 'discovered')
  `).run();
  const lead1Id = lead1.lastInsertRowid;

  const lead2 = db.prepare(`
    INSERT INTO leads (platform, name, ig_username, profile_url, source_keyword, status)
    VALUES ('instagram', 'Lead Two', 'lead_two', 'https://instagram.com/lead_two/', 'competitor_followers:competitor1', 'discovered')
  `).run();
  const lead2Id = lead2.lastInsertRowid;

  // 2. Insert trackers
  // Track 1: following for 35 days
  db.prepare(`
    INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at, eligible_for_unfollow, follow_source)
    VALUES (?, 'lead_one', 'following', datetime('now', '-35 days'), 0, 'competitor_followers:competitor1')
  `).run(lead1Id);

  // Track 2: requested for 15 days
  db.prepare(`
    INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at, eligible_for_unfollow, follow_source)
    VALUES (?, 'lead_two', 'requested', datetime('now', '-15 days'), 0, 'competitor_followers:competitor1')
  `).run(lead2Id);

  // 3. Test getFollowingCount()
  const followingCount = igFollowTracker.getFollowingCount();
  assert.equal(followingCount, 1);

  // 4. Test isFollowing()
  assert.equal(igFollowTracker.isFollowing("lead_one"), true);
  assert.equal(igFollowTracker.isFollowing("lead_two"), false);

  // 5. Test getUnfollowEligible()
  const eligible = igFollowTracker.getUnfollowEligible();
  assert.equal(eligible.length, 2);

  // 6. Test markUnfollowEligible()
  igFollowTracker.markUnfollowEligible("lead_one");
  const track1 = db.prepare("SELECT eligible_for_unfollow FROM ig_follow_tracker WHERE username = 'lead_one'").get();
  assert.equal(track1.eligible_for_unfollow, 1);

  // 7. Test getFollowBackRate()
  // Currently 0 followed back out of 2 followed
  const rateObj1 = igFollowTracker.getFollowBackRate();
  assert.equal(rateObj1.followed, 2);
  assert.equal(rateObj1.followedBack, 0);
  assert.equal(rateObj1.rate, 0);

  // Update track 1 to follow back
  db.prepare("UPDATE ig_follow_tracker SET follow_back_at = datetime('now') WHERE username = 'lead_one'").run();
  const rateObj2 = igFollowTracker.getFollowBackRate();
  assert.equal(rateObj2.followed, 2);
  assert.equal(rateObj2.followedBack, 1);
  assert.equal(rateObj2.rate, 0.5);

  // 8. Test getFollowsBySource()
  const grouped = igFollowTracker.getFollowsBySource();
  assert.ok(grouped.length > 0);
  assert.equal(grouped[0].source, "competitor_followers:competitor1");
  assert.equal(grouped[0].count, 2);

  const filtered = igFollowTracker.getFollowsBySource("competitor_followers:competitor1");
  assert.equal(filtered.length, 2);
});

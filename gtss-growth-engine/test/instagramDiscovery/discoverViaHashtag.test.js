/**
 * discoverViaHashtag tests — hashtag-based discovery pipeline.
 *
 * Verifies:
 *  - scrolls forward without reloads (single navigation to exploreUrl)
 *  - deduplicates posts already processed in this discovery session
 *  - deduplicates against an existing DB lead (duplicate_user)
 *  - keeps loading new posts as the feed lazy-loads more batches
 *  - logs iteration markers + duplicate metrics + saved/skipped events
 *  - writes qualified leads to the leads table with the correct source_keyword
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { getDb, discoverViaHashtag, createDiscoveryHarness } = require("./_helpers");

test("discoverViaHashtag scrolls forward without reloads, deduplicates, and keeps loading new posts", async () => {
  const db = getDb();
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM ig_warmup_sequences").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  // Insert a duplicate lead beforehand to test DB deduplication
  db.prepare(
    `
    INSERT INTO leads (platform, source_keyword, ig_username, profile_url, status)
    VALUES ('instagram', 'hashtag:nairobi', 'duplicate_user', 'https://instagram.com/duplicate_user', 'discovered')
  `,
  ).run();

  const exploreUrl = "https://www.instagram.com/explore/tags/nairobi/";
  const postA = "https://www.instagram.com/p/post-a/";
  const postB = "https://www.instagram.com/p/post-b/";
  const postC = "https://www.instagram.com/p/post-c/";
  const postD = "https://www.instagram.com/p/post-d/";
  const postE = "https://www.instagram.com/p/post-e/";

  const { feedPage, detailPage, feedState } = createDiscoveryHarness({
    exploreUrl,
    batches: [[postA, postB], [postB, postC, postD], [postE]],
    postToUsername: {
      [postA]: "duplicate_user",
      [postB]: "qualified_user",
      [postC]: "qualified_geo_user",
      [postD]: "qualified_user",
      [postE]: "qualified_scroll_user",
    },
    profileByUsername: {
      duplicate_user: {
        display_name: "Duplicate User",
        bio: "restaurant owner in Nairobi",
        website: "https://example.com",
        follower_count: 500,
        following_count: 40,
        post_count: 16,
        is_business: true,
        business_category: "Restaurant",
        email: "duplicate@example.com",
        phone: "+254700000001",
        is_verified: false,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_user: {
        display_name: "Qualified User",
        bio: "restaurant owner in Nairobi",
        website: "https://example.com",
        follower_count: 800,
        following_count: 50,
        post_count: 18,
        is_business: true,
        business_category: "Restaurant",
        email: "qualified@example.com",
        phone: "+254700000002",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_geo_user: {
        display_name: "Qualified Geo User",
        bio: "cafe founder in Nairobi",
        website: "https://example.com",
        follower_count: 900,
        following_count: 44,
        post_count: 21,
        is_business: true,
        business_category: "Cafe",
        email: "geo@example.com",
        phone: "+254700000003",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_scroll_user: {
        display_name: "Qualified Scroll User",
        bio: "boutique owner in Nairobi",
        website: "https://example.com",
        follower_count: 1100,
        following_count: 52,
        post_count: 25,
        is_business: true,
        business_category: "Boutique",
        email: "scroll@example.com",
        phone: "+254700000004",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
    },
  });

  const emitterLogs = [];
  const emitter = (type, message) => {
    emitterLogs.push({ type, message });
  };

  const result = await discoverViaHashtag(
    feedPage,
    { hashtag: "nairobi", maxLeads: 3 },
    emitter,
  );
  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(
    feedState.navigations.filter((url) => url === exploreUrl).length,
    1,
  );
  assert.ok(
    feedState.scrollEvents >= 2,
    "expected at least two scroll attempts for lazy-loaded pagination",
  );

  const iterationLogs = emitterLogs.filter(
    (log) => log.type === "info" && log.message.includes("iteration"),
  );
  assert.ok(
    iterationLogs.length >= 2,
    "expected multiple iteration logs for long-running discovery",
  );
  assert.ok(
    emitterLogs.some((log) => log.message.includes("duplicates=")),
    "expected duplicate metrics in logs",
  );
  assert.ok(
    emitterLogs.some(
      (log) =>
        log.message.includes("No new post links") ||
        log.message.includes("Feed appears exhausted"),
    ) || result.count === 3,
  );

  // DB assertions
  const duplicate = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'duplicate_user'")
    .get();
  assert.ok(duplicate);

  const qualified = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'qualified_user'")
    .get();
  assert.ok(qualified);
  assert.equal(qualified.source_keyword, "hashtag:nairobi");
  assert.equal(qualified.ig_has_email, 1);

  const scrollQualified = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'qualified_scroll_user'")
    .get();
  assert.ok(scrollQualified);
  assert.equal(scrollQualified.source_keyword, "hashtag:nairobi");

  // Verify emitter logs
  const savedLog = emitterLogs.find((log) => log.type === "saved");
  assert.ok(savedLog);
  assert.match(
    savedLog.message,
    /Saved qualified business lead: @qualified_user/,
  );

  const skippedLog = emitterLogs.find(
    (log) => log.type === "skipped" && log.message.includes("duplicate_user"),
  );
  assert.ok(skippedLog);

  const duplicateUsernameLog = emitterLogs.find((log) =>
    log.message.includes("already processed in this discovery session"),
  );
  assert.ok(duplicateUsernameLog);
});

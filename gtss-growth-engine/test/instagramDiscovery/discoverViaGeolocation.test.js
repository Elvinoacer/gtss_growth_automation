/**
 * discoverViaGeolocation tests — geolocation-based discovery pipeline.
 *
 * Verifies:
 *  - scrolls forward without reloads (single navigation to exploreUrl)
 *  - deduplicates within the session
 *  - writes qualified leads to the leads table with the correct
 *    source_keyword (`geolocation:<id>:<name>`)
 *  - reuses the detail page across multiple post/profile visits
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDb,
  discoverViaGeolocation,
  createDiscoveryHarness,
} = require("./_helpers");

test("discoverViaGeolocation scrolls forward without reloads, deduplicates, and grows lead counts", async () => {
  const db = getDb();
  db.prepare(
    "DELETE FROM leads WHERE ig_username IN ('geo_alpha_user', 'geo_beta_user')",
  ).run();

  const exploreUrl = "https://www.instagram.com/explore/locations/12345/";
  const post1 = "https://www.instagram.com/p/location-1/";
  const post2 = "https://www.instagram.com/p/location-2/";
  const post3 = "https://www.instagram.com/p/location-3/";
  const post4 = "https://www.instagram.com/p/location-4/";

  const { feedPage, detailPage, feedState } = createDiscoveryHarness({
    exploreUrl,
    batches: [[post1, post2], [post2, post3], [post4]],
    postToUsername: {
      [post1]: "geo_alpha_user",
      [post2]: "geo_beta_user",
      [post3]: "geo_beta_user",
      [post4]: "geo_gamma_user",
    },
    profileByUsername: {
      geo_alpha_user: {
        display_name: "Geo Alpha",
        bio: "boutique owner in Nairobi",
        website: "https://example.com",
        follower_count: 1200,
        following_count: 55,
        post_count: 19,
        is_business: true,
        business_category: "Boutique",
        email: "alpha@example.com",
        phone: "+254700000005",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      geo_beta_user: {
        display_name: "Geo Beta",
        bio: "cafe founder in Nairobi",
        website: "https://example.com",
        follower_count: 980,
        following_count: 48,
        post_count: 20,
        is_business: true,
        business_category: "Cafe",
        email: "beta@example.com",
        phone: "+254700000006",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      geo_gamma_user: {
        display_name: "Geo Gamma",
        bio: "salon owner in Nairobi",
        website: "https://example.com",
        follower_count: 780,
        following_count: 41,
        post_count: 15,
        is_business: true,
        business_category: "Salon",
        email: "gamma@example.com",
        phone: "+254700000007",
        is_verified: false,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
    },
  });

  const result = await discoverViaGeolocation(feedPage, {
    locationId: "12345",
    locationName: "Nairobi City",
    maxLeads: 3,
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(
    feedState.navigations.filter((url) => url === exploreUrl).length,
    1,
  );
  assert.ok(
    feedState.scrollEvents >= 2,
    "expected at least two scroll attempts for geolocation pagination",
  );

  const iterationLogs = result.leads.length ? true : false;
  assert.ok(iterationLogs);

  const alpha = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_alpha_user'")
    .get();
  const beta = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_beta_user'")
    .get();
  const gamma = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_gamma_user'")
    .get();
  assert.ok(alpha);
  assert.ok(beta);
  assert.ok(gamma);
  assert.equal(alpha.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(beta.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(gamma.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(alpha.ig_is_business, 1);
  assert.equal(beta.ig_is_business, 1);
  assert.equal(gamma.ig_is_business, 1);

  assert.ok(
    detailPage.navigations.length >= 3,
    "expected detail page to be reused for multiple post/profile visits",
  );
});

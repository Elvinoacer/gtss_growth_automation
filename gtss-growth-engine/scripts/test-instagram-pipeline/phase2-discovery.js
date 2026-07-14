/**
 * T2 — Discovery Filter Logic
 *
 * Verifies filterBusinessProfile qualifies/disqualifies a matrix of mock
 * profile inputs against expected boolean outcomes (website + follower_count,
 * email + post_count, bio + business_category, plus 2 negative cases).
 */

const assert = require("assert");

/**
 * @param {{}} ctx (no shared state used by this phase)
 */
async function runPhase2() {
  console.log("Running T2 — Discovery filter logic...");
  const {
    filterBusinessProfile,
  } = require("../../src/automation/instagramDiscovery");

  const mockProfiles = [
    {
      profileData: {
        website: "https://gtss.co",
        follower_count: 500,
      },
      expected: true,
    },
    {
      profileData: {
        email: "hello@gtss.co",
        post_count: 25,
      },
      expected: true,
    },
    {
      profileData: {
        bio: "Founder & manager of a restaurant based in Nairobi",
        business_category: "Local Business",
      },
      expected: true,
    },
    {
      profileData: {
        follower_count: 10,
      },
      expected: false,
    },
    {
      profileData: {
        post_count: 2,
      },
      expected: false,
    },
  ];

  for (let i = 0; i < mockProfiles.length; i++) {
    const { profileData, expected } = mockProfiles[i];
    const res = filterBusinessProfile(profileData);
    assert.strictEqual(
      res.passes,
      expected,
      `T2 Profile #${i + 1} assertion failed: expected passes=${expected}, got ${res.passes}`,
    );
  }
  console.log("✅ T2 Filter logic — PASS\n");
}

module.exports = { runPhase2 };

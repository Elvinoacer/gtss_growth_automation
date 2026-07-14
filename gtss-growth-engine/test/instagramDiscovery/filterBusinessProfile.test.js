/**
 * filterBusinessProfile tests — Instagram business profile qualification.
 *
 * Verifies the 2+ indicator threshold and the bio-keyword + business-category
 * signals work for three edge-case profiles.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { filterBusinessProfile } = require("./_helpers");

test("filterBusinessProfile qualifies profiles correctly", () => {
  // Edge Case 1: Less than 2 indicators (fails)
  const failProfile = {
    website: null,
    email: null,
    phone: null,
    follower_count: 50,
    bio: "Just a casual account",
    post_count: 5,
    business_category: null,
  };
  const result1 = filterBusinessProfile(failProfile);
  assert.equal(result1.passes, false);
  assert.match(result1.reason, /Disqualified/);

  // Edge Case 2: 2 indicators (passes) - follower count in range, bio keyword matched
  const passProfile1 = {
    website: null,
    email: null,
    phone: null,
    follower_count: 500,
    bio: "restaurant owner in Nairobi",
    post_count: 5,
    business_category: null,
  };
  const result2 = filterBusinessProfile(passProfile1);
  assert.equal(result2.passes, true);
  assert.match(result2.reason, /Qualified/);

  // Edge Case 3: 3 indicators (passes) - website in bio, email, business category present
  const passProfile2 = {
    website: "https://example.com",
    email: "cafe@example.com",
    phone: null,
    follower_count: 5,
    bio: "personal blog",
    post_count: 1,
    business_category: "Café",
  };
  const result3 = filterBusinessProfile(passProfile2);
  assert.equal(result3.passes, true);
});

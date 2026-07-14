/**
 * instagramDiscovery/filterBusinessProfile.js
 *
 * Score a scraped Instagram profile against six local-business indicators.
 * At least 2 of 6 must match for the profile to qualify as a business lead:
 *   1. Has website in bio
 *   2. Has email or phone contact info
 *   3. Follower count in [100, 50000]
 *   4. Bio contains a local business keyword (owner, founder, café, nairobi, …)
 *   5. Post count > 10
 *   6. Business category is non-null
 *
 * Returns { passes, reason } — `reason` is a human-readable summary that is
 * emitted via safeEmit so the pipelines UI can show why each profile was
 * accepted or rejected.
 *
 * Pure function — no IO, no browser interaction. Kept in its own file so the
 * scoring rubric is easy to audit and tweak.
 */

/**
 * Analyzes a scraped Instagram profile against local business indicators (2 out of 6 must match).
 * @param {object} profileData - Raw scraped profile attributes
 * @returns {object} { passes: boolean, reason: string }
 */
function filterBusinessProfile(profileData) {
  if (!profileData) {
    return { passes: false, reason: "No profile data provided" };
  }

  let score = 0;
  const matches = [];

  // 1. Has website in bio
  if (profileData.website) {
    score++;
    matches.push("website_in_bio");
  }

  // 2. Has email or phone
  if (profileData.email || profileData.phone) {
    score++;
    matches.push("contact_info_present");
  }

  // 3. Follower count in range [100, 50000]
  const followers = profileData.follower_count || 0;
  if (followers >= 100 && followers <= 50000) {
    score++;
    matches.push(`follower_count_in_range_${followers}`);
  }

  // 4. Bio contains local business keywords
  const bioKeywords = [
    "owner",
    "founder",
    "ceo",
    "manager",
    "restaurant",
    "café",
    "cafe",
    "hotel",
    "shop",
    "salon",
    "gym",
    "bar",
    "grill",
    "nairobi",
    "kenya",
    "business",
  ];
  const bioText = (profileData.bio || "").toLowerCase();
  const keywordMatch = bioKeywords.some((keyword) => bioText.includes(keyword));
  if (keywordMatch) {
    score++;
    matches.push("bio_keywords_matched");
  }

  // 5. Post count > 10
  const posts = profileData.post_count || 0;
  if (posts > 10) {
    score++;
    matches.push(`active_posts_${posts}`);
  }

  // 6. Business category is non-null
  if (profileData.business_category) {
    score++;
    matches.push(`business_category_${profileData.business_category}`);
  }

  const passes = score >= 2;
  return {
    passes,
    reason: passes
      ? `Qualified: Match score ${score} indicators: (${matches.join(", ")})`
      : `Disqualified: Match score ${score} indicators: (${matches.join(", ")})`,
  };
}

module.exports = { filterBusinessProfile };

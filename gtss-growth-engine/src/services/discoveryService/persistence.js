/**
 * Discovery Service — Lead Persistence
 * Builds DB-ready lead records from arbitrary profile shapes (LinkedIn / X /
 * Facebook / Instagram), validates them before insert, and batch-inserts
 * new leads into the `leads` table with INSERT...WHERE NOT EXISTS dedup.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { resolveInstagramUsername } = require("../../utils/instagramUsername");
const { cleanText, normalizeXHandle } = require("./textParsing");
const {
  normalizeOptionalText,
  normalizeOptionalInteger,
  normalizeOptionalFlag,
} = require("./linkedinSearch");

/**
 * Coerce an arbitrary lead-profile object (LinkedIn / X / Facebook / Instagram)
 * into the canonical record shape that matches the `leads` table schema.
 *
 * For Instagram leads, fills in the ig_* columns (username, follower / following
 * / post counts, business category, contact flags, bio).
 * For X leads, fills in x_handle (and synthesises a profile URL if missing).
 * For LinkedIn / Facebook, fills in x_handle from the profile if present.
 */
function buildLeadPersistenceRecord(profile) {
  const platform = cleanText(profile.platform).toLowerCase();
  const name = normalizeOptionalText(profile.name || profile.display_name || profile.handle) || null;
  const role = normalizeOptionalText(profile.role) || null;
  const company = normalizeOptionalText(profile.company) || null;
  const location = normalizeOptionalText(profile.location) || null;
  const website = normalizeOptionalText(profile.website) || null;
  const sourceKeyword = normalizeOptionalText(profile.source_keyword) || null;
  let profileUrl = normalizeOptionalText(profile.profile_url);
  let xHandle = null;
  let igUsername = null;
  let igFollowerCount = null;
  let igFollowingCount = null;
  let igPostCount = null;
  let igIsBusiness = null;
  let igBusinessCategory = null;
  let igHasEmail = null;
  let igHasPhone = null;
  let igBio = null;

  if (platform === "instagram") {
    igUsername = resolveInstagramUsername(profile) || null;
    if (!profileUrl && igUsername) {
      profileUrl = `https://www.instagram.com/${igUsername}/`;
    }
    igFollowerCount = normalizeOptionalInteger(profile.ig_follower_count ?? profile.follower_count);
    igFollowingCount = normalizeOptionalInteger(profile.ig_following_count ?? profile.following_count);
    igPostCount = normalizeOptionalInteger(profile.ig_post_count ?? profile.post_count);
    igIsBusiness = normalizeOptionalFlag(profile.ig_is_business ?? profile.is_business);
    igBusinessCategory = normalizeOptionalText(profile.ig_business_category ?? profile.business_category) || null;
    igHasEmail = normalizeOptionalFlag(profile.ig_has_email ?? profile.email);
    igHasPhone = normalizeOptionalFlag(profile.ig_has_phone ?? profile.phone);
    igBio = normalizeOptionalText(profile.ig_bio ?? profile.bio) || null;
  } else if (platform === "x") {
    xHandle = normalizeXHandle(profile.x_handle || profile.handle || "") || null;
    if (!profileUrl && xHandle) {
      profileUrl = `https://x.com/${xHandle}`;
    }
  } else {
    xHandle = normalizeOptionalText(profile.x_handle || profile.handle) || null;
  }

  return {
    platform,
    name,
    role,
    company,
    location,
    profile_url: profileUrl,
    website,
    source_keyword: sourceKeyword,
    status: normalizeOptionalText(profile.status) || "discovered",
    x_handle: xHandle,
    ig_username: igUsername,
    ig_follower_count: igFollowerCount,
    ig_following_count: igFollowingCount,
    ig_post_count: igPostCount,
    ig_is_business: igIsBusiness,
    ig_business_category: igBusinessCategory,
    ig_has_email: igHasEmail,
    ig_has_phone: igHasPhone,
    ig_bio: igBio,
  };
}

/**
 * Validate a buildLeadPersistenceRecord() output. Returns
 *   { valid: boolean, issues: string[] }
 * where issues is e.g. ["missing profile_url", "missing ig_username"].
 */
function validateLeadPersistenceRecord(record) {
  const issues = [];

  if (!record.platform) {
    issues.push("missing platform");
  }

  if (!record.profile_url) {
    issues.push("missing profile_url");
  }

  if (record.platform === "instagram" && !record.ig_username) {
    issues.push("missing ig_username");
  }

  if (record.platform === "x" && !record.x_handle) {
    issues.push("missing x_handle");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Batch-insert leads into the `leads` table. Each profile is normalised via
 * buildLeadPersistenceRecord() and validated via validateLeadPersistenceRecord();
 * invalid records are skipped (and warned). Duplicates (by profile_url) are
 * counted but not inserted (INSERT...WHERE NOT EXISTS).
 *
 * Returns { total, new, duplicates, invalid }.
 */
function insertLeads(profiles) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO leads (
      platform, name, role, company, location, profile_url, website, source_keyword, status,
      x_handle, ig_username, ig_follower_count, ig_following_count, ig_post_count,
      ig_is_business, ig_business_category, ig_has_email, ig_has_phone, ig_bio
    )
    SELECT
      @platform, @name, @role, @company, @location, @profile_url, @website, @source_keyword, @status,
      @x_handle, @ig_username, @ig_follower_count, @ig_following_count, @ig_post_count,
      @ig_is_business, @ig_business_category, @ig_has_email, @ig_has_phone, @ig_bio
    WHERE NOT EXISTS (SELECT 1 FROM leads WHERE profile_url = @profile_url)
  `);
  let inserted = 0;
  let duplicates = 0;
  let invalid = 0;
  const tx = db.transaction((list) => {
    list.forEach((profile, index) => {
      const record = buildLeadPersistenceRecord(profile || {});
      const validation = validateLeadPersistenceRecord(record);

      if (!validation.valid) {
        invalid++;
        logger.warn("DISCOVERY_PERSISTENCE", "Skipping invalid lead payload", {
          index,
          platform: record.platform || "unknown",
          issues: validation.issues,
        });
        return;
      }

      const result = insert.run(record);
      if (result.changes > 0) {
        inserted++;
      } else {
        duplicates++;
      }
    });
  });
  tx(Array.isArray(profiles) ? profiles : []);

  logger.info("DISCOVERY_PERSISTENCE", "Lead persistence batch completed", {
    total: Array.isArray(profiles) ? profiles.length : 0,
    inserted,
    duplicates,
    invalid,
  });

  return {
    total: Array.isArray(profiles) ? profiles.length : 0,
    new: inserted,
    duplicates,
    invalid,
  };
}

module.exports = {
  buildLeadPersistenceRecord,
  validateLeadPersistenceRecord,
  insertLeads,
};

const { getDb } = require("../db/database");

/**
 * Get count of active following trackers where status = 'following'.
 * @returns {number}
 */
function getFollowingCount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS count FROM ig_follow_tracker WHERE status = 'following'").get();
  return row ? row.count : 0;
}

/**
 * Retrieve leads eligible for unfollow (30d+ for followed, or 14d+ for requested).
 * @param {number} [limit] - Max records to return
 * @returns {Array<object>}
 */
function getUnfollowEligible(limit) {
  const db = getDb();
  let query = `
    SELECT t.*, l.name, l.profile_url
    FROM ig_follow_tracker t
    JOIN leads l ON t.lead_id = l.id
    WHERE t.status IN ('following', 'requested')
      AND (
        (t.status = 'following' AND t.followed_at <= datetime('now', '-30 days'))
        OR (t.status = 'requested' AND t.followed_at <= datetime('now', '-14 days'))
      )
  `;
  if (limit) {
    query += ` LIMIT ${limit}`;
  }
  return db.prepare(query).all();
}

/**
 * Mark a lead eligible for unfollow by setting eligible_for_unfollow = 1.
 * @param {string} igUsername - Target profile username
 */
function markUnfollowEligible(igUsername) {
  const db = getDb();
  db.prepare(`
    UPDATE ig_follow_tracker
    SET eligible_for_unfollow = 1
    WHERE username = ? OR lead_id IN (SELECT id FROM leads WHERE ig_username = ?)
  `).run(igUsername, igUsername);
}

/**
 * Retrieve the follow-back rate statistics.
 * @returns {object} { followed, followedBack, rate }
 */
function getFollowBackRate() {
  const db = getDb();
  const totalFollowed = db.prepare("SELECT COUNT(*) AS count FROM ig_follow_tracker").get().count;
  const followedBack = db.prepare("SELECT COUNT(*) AS count FROM ig_follow_tracker WHERE follow_back_at IS NOT NULL").get().count;
  const rate = totalFollowed > 0 ? parseFloat((followedBack / totalFollowed).toFixed(4)) : 0.0;
  return { followed: totalFollowed, followedBack, rate };
}

/**
 * Retrieve leads followed by a source or group them by follow_source.
 * @param {string} [source] - Specific follow source filter
 * @returns {Array<object>}
 */
function getFollowsBySource(source) {
  const db = getDb();
  if (source) {
    return db.prepare(`
      SELECT t.*, l.source_keyword
      FROM ig_follow_tracker t
      JOIN leads l ON t.lead_id = l.id
      WHERE t.follow_source = ? OR l.source_keyword = ?
    `).all(source, source);
  } else {
    return db.prepare(`
      SELECT COALESCE(t.follow_source, l.source_keyword, 'unknown') AS source, COUNT(*) AS count
      FROM ig_follow_tracker t
      JOIN leads l ON t.lead_id = l.id
      GROUP BY source
    `).all();
  }
}

/**
 * Check if the user is currently followed.
 * @param {string} igUsername - Profile username
 * @returns {boolean}
 */
function isFollowing(igUsername) {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM ig_follow_tracker
    WHERE (username = ? OR lead_id IN (SELECT id FROM leads WHERE ig_username = ?))
      AND status = 'following'
  `).get(igUsername, igUsername);
  return !!row;
}

module.exports = {
  getFollowingCount,
  getUnfollowEligible,
  markUnfollowEligible,
  getFollowBackRate,
  getFollowsBySource,
  isFollowing
};

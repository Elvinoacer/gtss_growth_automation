/**
 * messages/stats.js — Stats loader for the Message Generator page.
 *
 * Fetches /api/messages/stats and updates the per-status counters (stat
 * pending/approved/sent/skipped/followups/unscored-qualified), the per-tab
 * counts, the char-limit table (used by getCharLimitForPlatform in
 * helpers.js), and the unscored-qualified help note. Toggles a friendly
 * message explaining whether qualified leads still need scoring.
 *
 * Exposes (via global scope):
 *   - loadStats()  — async, called on page init and after every action
 *                    that mutates lead status (approve/skip/regenerate)
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, statPending, statApproved, statSent, statSkipped,
 *     statFollowups, statUnscoredQualified, unscoredQualifiedNote,
 *     tabPending, tabApprovedCount, tabSent, tabFollowups, charLimits
 */

async function loadStats() {
  try {
    const stats = await fetchJSON("/api/messages/stats");
    statPending.textContent = stats.pending;
    statApproved.textContent = stats.approved;
    statSent.textContent = stats.sent;
    statSkipped.textContent = stats.skipped;
    statFollowups.textContent = stats.followUps;
    if (statUnscoredQualified) {
      statUnscoredQualified.textContent = stats.unscored_qualified || 0;
    }
    tabPending.textContent = stats.pending;
    tabApprovedCount.textContent = stats.approved;
    tabSent.textContent = stats.sent;
    tabFollowups.textContent = stats.followUps;

    if (stats.charLimits) charLimits = stats.charLimits;
    if (unscoredQualifiedNote) {
      unscoredQualifiedNote.textContent =
        stats.unscored_qualified > 0
          ? `${stats.unscored_qualified} qualified lead(s) still have no AI score and will be included in Generate All.`
          : "All qualified leads already have AI scores.";
    }
  } catch (err) {
    console.error("Failed to load stats", err);
  }
}

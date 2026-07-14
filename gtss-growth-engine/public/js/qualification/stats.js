/**
 * qualification/stats.js — Stats loader for the Lead Qualification page.
 *
 * Fetches /api/qualification/stats and updates the per-status counters
 * (stat pending/qualified/deprioritized/overridden/scoring-failed) plus
 * the per-tab counts. Toggles a gentle pulse on the "Proceed to Messages"
 * button when there are qualified leads ready to move to outreach.
 *
 * Exposes (via global scope):
 *   - loadStats() — async, called on page init and after every action
 *                   that mutates lead status (approve / reject / override /
 *                   manual-qualify)
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - fetchJSON, statPending, statQualified, statDeprioritized,
 *     statOverridden, statScoringFailed, tabPending, tabApproved,
 *     tabRejected, tabOverridden, tabScoringFailed
 */

async function loadStats() {
  try {
    const stats = await fetchJSON("/api/qualification/stats");
    statPending.textContent = stats.pending;
    statQualified.textContent = stats.qualified;
    statDeprioritized.textContent = stats.deprioritized;
    statOverridden.textContent = stats.overridden;

    // Toggle the gentle pulse on the "Proceed to Messages" button when
    // there are qualified leads ready to move to outreach.
    const proceedBtn = document.getElementById("proceed-to-messages-btn");
    if (proceedBtn) {
      if (stats.qualified > 0) {
        proceedBtn.classList.add("proceed-pulse");
      } else {
        proceedBtn.classList.remove("proceed-pulse");
      }
    }
    if (statScoringFailed) {
      statScoringFailed.textContent = stats.scoring_failed || 0;
    }
    tabPending.textContent = stats.pending;
    tabApproved.textContent = stats.qualified;
    tabRejected.textContent = stats.deprioritized;
    tabOverridden.textContent = stats.overridden;
    if (tabScoringFailed) {
      tabScoringFailed.textContent = stats.scoring_failed || 0;
    }
  } catch (err) {
    console.error("Failed to load stats", err);
  }
}

/**
 * qualification/init.js — Launch-time boot sequence for the Lead
 * Qualification page. Loaded LAST (after every other split file) so all
 * referenced functions are guaranteed to exist.
 *
 * Defines:
 *   - restoreFilterFromHash() — reads window.location.hash and, if it
 *                                matches a valid filter status, restores
 *                                the active filter tab accordingly
 *
 * Then runs the boot calls in order:
 *   1. restoreFilterFromHash()      — sync the filter tab from the URL
 *   2. loadStats()                  — initial stat counters
 *   3. loadLeads()                  — first page of leads
 *   4. resumeActiveQualification()  — reattach to a running qualification
 *      job, if any
 *
 * Depends on (from qualification/state.js, loaded earlier):
 *   - filterTabs, currentFilter
 * Depends on (from qualification/stats.js, loaded earlier):
 *   - loadStats
 * Depends on (from qualification/table.js, loaded earlier):
 *   - loadLeads
 * Depends on (from qualification/runQualification.js, loaded earlier):
 *   - resumeActiveQualification
 */

function restoreFilterFromHash() {
  const hash = window.location.hash.replace("#", "");
  const validFilters = [
    "all",
    "pending",
    "approved",
    "rejected",
    "scoring_failed",
    "overridden",
  ];
  if (validFilters.includes(hash)) {
    currentFilter = hash;
    filterTabs.querySelectorAll(".filter-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.status === currentFilter);
    });
  }
}

restoreFilterFromHash();
loadStats();
loadLeads();
resumeActiveQualification();

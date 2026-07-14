/**
 * discovery/history.js — Discovery-run history table + rerun action for
 * the Discovery page.
 *
 * Exposes (via global scope):
 *   - loadHistory() — async; GET /api/discovery/history, render the
 *                     history-table-body with one row per past run
 *                     (keyword + platform badges + leads found + run date
 *                     + Re-run button)
 *   - rerun(id)     — async; POST /api/discovery/history/:id/rerun; kicks
 *                     off a fresh discovery job using the same platforms
 *                     as the original run, then enters the running state
 *                     with the correct platform list
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - discoveryState (not directly, but indirectly via enterRunningState)
 * Depends on (from discovery/helpers.js, loaded earlier):
 *   - platformBadge, formatDate, escapeHtml, selectedPlatforms
 * Depends on (from discovery/discoveryStream.js, loaded earlier):
 *   - enterRunningState
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON, showToast
 */

async function loadHistory() {
  const data = await window.gtss.fetchJSON("/api/discovery/history");
  const tbody = document.getElementById("history-table-body");
  const runs = data.runs || [];

  tbody.innerHTML = runs
    .map(
      (run) => `
    <tr>
      <td>${escapeHtml(run.keyword)}</td>
      <td>${(run.platforms || []).map(platformBadge).join(" ")}</td>
      <td>${run.leads_found || 0}</td>
      <td>${formatDate(run.run_at)}</td>
      <td><button class="row-button" data-rerun="${run.id}" type="button">Re-run</button></td>
    </tr>
  `,
    )
    .join("");
}

async function rerun(id) {
  try {
    const data = await window.gtss.fetchJSON(
      `/api/discovery/history/${id}/rerun`,
      { method: "POST" },
    );
    window.gtss.showToast(
      `Discovery rerun started: job ${data.jobId}`,
      "success",
    );
    // The rerun endpoint returns the platforms that will actually be scanned
    // (taken from the original run record) so the completion summary lists
    // the correct platforms instead of whatever is currently checked.
    const rerunPlatforms =
      Array.isArray(data.platforms) && data.platforms.length
        ? data.platforms
        : selectedPlatforms();
    document.getElementById("live-log").innerHTML = "";
    enterRunningState(data.jobId, rerunPlatforms, "Re-running discovery...");
  } catch (error) {
    window.gtss.showToast(error.message, "error");
  }
}

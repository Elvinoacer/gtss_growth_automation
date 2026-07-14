/**
 * discovery/queueActions.js — Add-to-queue / dismiss / removeRows for the
 * Discovery page's discovered-leads results table.
 *
 * "Add to Queue" pushes discovered leads into the qualification queue
 * (POST /api/discovery/add-to-queue) and removes them from the discovery
 * results table. "Dismiss" hides them from discovery (POST
 * /api/discovery/dismiss) and also removes them from the table.
 *
 * Exposes (via global scope):
 *   - addToQueue(ids)   — async; POST /api/discovery/add-to-queue with
 *                         { leadIds: ids }; on success, removes the rows
 *                         and reloads the table
 *   - dismiss(ids)      — async; POST /api/discovery/dismiss with
 *                         { leadIds: ids }; on success, removes the rows
 *                         and reloads the table
 *   - removeRows(ids)   — visual fade-out: adds the `.fading` class to
 *                         each matching `[data-lead-row]` row
 *
 * Depends on (from discovery/results.js, loaded earlier):
 *   - loadResults
 * Depends on (from window.gtss, available via app.js):
 *   - fetchJSON, showToast
 */

async function addToQueue(ids) {
  const data = await window.gtss.fetchJSON("/api/discovery/add-to-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadIds: ids }),
  });
  window.gtss.showToast(
    `${data.updated} leads added to qualification queue`,
    "success",
  );
  removeRows(ids);
  await loadResults();
}

async function dismiss(ids) {
  const data = await window.gtss.fetchJSON("/api/discovery/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadIds: ids }),
  });
  window.gtss.showToast(`${data.updated} leads dismissed`, "success");
  removeRows(ids);
  await loadResults();
}

function removeRows(ids) {
  ids.forEach((id) => {
    const row = document.querySelector(`[data-lead-row="${id}"]`);
    if (row) row.classList.add("fading");
  });
}

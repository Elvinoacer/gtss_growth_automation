/**
 * discovery/events.js — All top-level event bindings for the Discovery
 * page, wrapped in a single `bindEvents()` function that init.js calls
 * after the platform controls + discovery config + keyword selector have
 * finished loading.
 *
 * The original discovery.js declared `bindEvents` as a top-level function
 * and called it from a DOMContentLoaded handler. The split preserves both
 * the function and the late-binding style — the listener attachments
 * reference DOM elements that don't exist until the platform-row <input>s
 * have been injected by loadPlatformControls, so they must run after that
 * initial render.
 *
 * Wires:
 *   - #discovery-form submit (→ startDiscovery)
 *   - #max-leads-input change (→ saveDiscoveryConfig)
 *   - #stop-button click (→ stopDiscovery)
 *   - #apply-filters + per-filter change handlers (→ reset page + reload)
 *   - #prev-page / #next-page click (→ pagination)
 *   - #select-all change (→ toggle every row checkbox + selectedIds)
 *   - #results-body change (→ per-row checkbox → selectedIds + bulk bar)
 *   - #results-body click delegation (→ Add to Queue / Dismiss)
 *   - #bulk-qualify / #bulk-dismiss click (→ bulk addToQueue / dismiss)
 *   - #history-toggle click (→ expand/collapse the history panel)
 *   - #history-table-body click delegation (→ rerun button)
 *
 * Exposes (via global scope):
 *   - bindEvents()
 *
 * Depends on (from discovery/state.js, loaded earlier):
 *   - discoveryState
 * Depends on (from discovery/discoveryStream.js, loaded earlier):
 *   - startDiscovery, stopDiscovery
 * Depends on (from discovery/results.js, loaded earlier):
 *   - loadResults, updateBulkBar
 * Depends on (from discovery/queueActions.js, loaded earlier):
 *   - addToQueue, dismiss
 * Depends on (from discovery/history.js, loaded earlier):
 *   - rerun
 * Depends on (from discovery/discoveryConfig.js, loaded earlier):
 *   - saveDiscoveryConfig
 * Depends on (from window.gtss, available via app.js):
 *   - showToast
 */

function bindEvents() {
  document
    .getElementById("discovery-form")
    .addEventListener("submit", startDiscovery);

  const maxLeadsInput = document.getElementById("max-leads-input");
  if (maxLeadsInput) {
    maxLeadsInput.addEventListener("change", saveDiscoveryConfig);
  }

  document
    .getElementById("stop-button")
    .addEventListener("click", stopDiscovery);
  document.getElementById("apply-filters").addEventListener("click", () => {
    discoveryState.page = 1;
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  [
    "platform-filter",
    "keyword-filter",
    "date-from-filter",
    "date-to-filter",
  ].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      discoveryState.page = 1;
      loadResults().catch((error) =>
        window.gtss.showToast(error.message, "error"),
      );
    });
  });
  document.getElementById("prev-page").addEventListener("click", () => {
    discoveryState.page = Math.max(discoveryState.page - 1, 1);
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("next-page").addEventListener("click", () => {
    discoveryState.page += 1;
    loadResults().catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("select-all").addEventListener("change", (event) => {
    document.querySelectorAll(".lead-select").forEach((checkbox) => {
      checkbox.checked = event.target.checked;
      const id = Number(checkbox.value);
      if (checkbox.checked) discoveryState.selectedIds.add(id);
      else discoveryState.selectedIds.delete(id);
    });
    updateBulkBar();
  });
  document
    .getElementById("results-body")
    .addEventListener("change", (event) => {
      if (!event.target.classList.contains("lead-select")) return;
      const id = Number(event.target.value);
      if (event.target.checked) discoveryState.selectedIds.add(id);
      else discoveryState.selectedIds.delete(id);
      updateBulkBar();
    });
  document
    .getElementById("results-body")
    .addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = Number(button.dataset.id);
      try {
        if (button.dataset.action === "queue") await addToQueue([id]);
        if (button.dataset.action === "dismiss") await dismiss([id]);
      } catch (error) {
        window.gtss.showToast(error.message, "error");
      }
    });
  document.getElementById("bulk-qualify").addEventListener("click", () => {
    addToQueue([...discoveryState.selectedIds]).catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("bulk-dismiss").addEventListener("click", () => {
    dismiss([...discoveryState.selectedIds]).catch((error) =>
      window.gtss.showToast(error.message, "error"),
    );
  });
  document.getElementById("history-toggle").addEventListener("click", () => {
    const body = document.getElementById("history-body");
    const open = !body.classList.contains("visible");
    body.classList.toggle("visible", open);
    document.getElementById("history-title").textContent =
      `${open ? "▲" : "▼"} Discovery History`;
  });
  document
    .getElementById("history-table-body")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-rerun]");
      if (button) rerun(button.dataset.rerun);
    });
}

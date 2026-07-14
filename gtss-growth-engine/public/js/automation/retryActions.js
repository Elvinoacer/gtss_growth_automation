/* global gtss */
/**
 * automation/retryActions.js — Retry / skip / select-all action handlers
 * for the Automation Control page queue.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 428-472 for
 * retryQueue / retrySelectedQueue / updateSelectedRetryButton; lines
 * 797-887 for the queueBody click + retry button + select-all + retry-all
 * + retry-waiting + retry-blocked + retry-by-category bindings). The
 * queue-body click handler delegates both checkbox toggles and per-row
 * Retry / Skip button clicks; the others are dedicated button listeners.
 *
 * Exposes (via global scope):
 *   - retryQueue(mode, category=null) — POST /api/automation/queue/retry-all
 *     with { mode, category }; mode is "all" | "waiting" | "blocked"
 *   - retrySelectedQueue() — POST /api/automation/queue/retry-selected
 *     with { messageIds: [...selectedRetryIds] }
 *   - updateSelectedRetryButton() — sync the "Retry Selected" button's
 *     label + visibility with the current selectedRetryIds size, and sync
 *     the select-all checkbox state (checked / indeterminate / unchecked)
 *
 * Top-level bindings (registered at script-load time):
 *   - queueBody "click" (delegated):
 *       - .queue-retry-checkbox → toggle membership in selectedRetryIds
 *       - .retry-btn            → PATCH /api/automation/queue/:id/retry
 *       - .skip-btn             → PATCH /api/automation/queue/:id/skip
 *   - queueSummary "click" on .retry-category-btn → retryQueue("all", category)
 *   - retrySelectedBtn "click" → retrySelectedQueue()
 *   - queueSelectAll "change" → check/uncheck every queue-retry-checkbox
 *     and sync selectedRetryIds
 *   - retryAllBtn "click"      → retryQueue("all")
 *   - retryWaitingBtn "click"  → retryQueue("waiting")
 *   - retryBlockedBtn "click"  → retryQueue("blocked")
 */

async function retryQueue(mode, category = null) {
  try {
    const result = await fetchJSON("/api/automation/queue/retry-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, category }),
    });
    showToast(
      result.updated > 0
        ? `${result.updated} action(s) returned to the queue`
        : "No actions matched that retry filter",
      result.updated > 0 ? "success" : "info",
    );
    await loadQueue();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function updateSelectedRetryButton() {
  if (retrySelectedBtn) {
    retrySelectedBtn.style.display = selectedRetryIds.size > 0 ? "flex" : "none";
    retrySelectedBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">checklist</span> ${selectedRetryIds.size > 0 ? `Retry Selected (${selectedRetryIds.size})` : "Retry Selected"}`;
  }
  if (queueSelectAll) {
    const checkboxes = [...document.querySelectorAll(".queue-retry-checkbox")];
    queueSelectAll.checked = checkboxes.length > 0 && checkboxes.every((box) => box.checked);
    queueSelectAll.indeterminate = checkboxes.some((box) => box.checked) && !queueSelectAll.checked;
  }
}

async function retrySelectedQueue() {
  try {
    const result = await fetchJSON("/api/automation/queue/retry-selected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: [...selectedRetryIds] }),
    });
    showToast(`${result.updated} selected action(s) returned to the queue`, result.updated > 0 ? "success" : "info");
    selectedRetryIds.clear();
    await loadQueue();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ----------------------------------------------------------------
// Skip / Retry / Select-all — queue-body delegated click handler
// ----------------------------------------------------------------

queueBody.addEventListener("click", async (e) => {
  const checkbox = e.target.closest(".queue-retry-checkbox");
  if (checkbox) {
    const id = Number(checkbox.dataset.id);
    if (checkbox.checked) selectedRetryIds.add(id);
    else selectedRetryIds.delete(id);
    updateSelectedRetryButton();
    return;
  }

  const retryBtn = e.target.closest(".retry-btn");
  if (retryBtn) {
    const id = retryBtn.dataset.id;
    try {
      await fetchJSON(`/api/automation/queue/${id}/retry`, {
        method: "PATCH",
      });
      showToast("Action returned to queue", "success");
      await loadQueue();
    } catch (err) {
      showToast(err.message, "error");
    }
    return;
  }

  const skipBtn = e.target.closest(".skip-btn");
  if (!skipBtn) return;

  const id = skipBtn.dataset.id;
  try {
    await fetchJSON(`/api/automation/queue/${id}/skip`, { method: "PATCH" });
    showToast("Action skipped", "info");
    await loadQueue();
  } catch (err) {
    showToast(err.message, "error");
  }
});

// ----------------------------------------------------------------
// Retry-by-category (queue-summary delegated click)
// ----------------------------------------------------------------

if (queueSummary) {
  queueSummary.addEventListener("click", async (e) => {
    const categoryBtn = e.target.closest(".retry-category-btn");
    if (!categoryBtn) return;
    await retryQueue("all", categoryBtn.dataset.category);
  });
}

// ----------------------------------------------------------------
// Bulk retry buttons + select-all
// ----------------------------------------------------------------

if (retrySelectedBtn) {
  retrySelectedBtn.addEventListener("click", retrySelectedQueue);
}
if (queueSelectAll) {
  queueSelectAll.addEventListener("change", () => {
    document.querySelectorAll(".queue-retry-checkbox").forEach((checkbox) => {
      checkbox.checked = queueSelectAll.checked;
      const id = Number(checkbox.dataset.id);
      if (queueSelectAll.checked) selectedRetryIds.add(id);
      else selectedRetryIds.delete(id);
    });
    updateSelectedRetryButton();
  });
}
if (retryAllBtn) {
  retryAllBtn.addEventListener("click", async () => retryQueue("all"));
}
if (retryWaitingBtn) {
  retryWaitingBtn.addEventListener("click", async () =>
    retryQueue("waiting"),
  );
}
if (retryBlockedBtn) {
  retryBlockedBtn.addEventListener("click", async () =>
    retryQueue("blocked"),
  );
}

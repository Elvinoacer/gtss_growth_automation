/* global gtss */
/**
 * automation/queue.js — Queue rendering (table + summary + per-row actions)
 * + run-summary banner for the Automation Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 283-426 for
 * the loaders/renderers, lines 474-593 for the row renderers). The retry
 * action handlers and queue-body click binding live in retryActions.js
 * (they share the `selectedRetryIds` set with that file's checkbox state).
 *
 * Exposes (via global scope):
 *   - loadQueue() — Promise.allSettled([/api/automation/queue,
 *     /api/automation/queue/summary]), then renderQueue + renderQueueSummary
 *   - buildQueueSummary(queue) — fallback summary computation if the
 *     /queue/summary endpoint fails
 *   - renderQueueSummary(summary) — renders the queue-summary bar with
 *     runnable/waiting/blocked counts + per-category retry buttons
 *   - renderRunSummary(summary) — renders the post-run banner with
 *     sent/failed/skipped/waiting/blocked badges
 *   - renderQueueGroup(title, toneClass, items) — renders a single
 *     group header row + its child rows
 *   - renderQueueRow(action) — renders a single queue row with status
 *     dot, category badge, retry count, snooze-until, last-error tooltip,
 *     and per-row Retry / Skip hover buttons
 *   - renderQueue(queue) — splits the queue into runnable / waiting /
 *     blocked groups and renders them via renderQueueGroup
 */

// ----------------------------------------------------------------
// Queue Summary + Queue
// ----------------------------------------------------------------

async function loadQueue() {
  try {
    const [queueResult, summaryResult] = await Promise.allSettled([
      fetchJSON("/api/automation/queue"),
      fetchJSON("/api/automation/queue/summary"),
    ]);

    const queue = queueResult.status === "fulfilled" ? queueResult.value : [];
    const summary =
      summaryResult.status === "fulfilled"
        ? summaryResult.value
        : buildQueueSummary(queue);

    renderQueue(queue);
    renderQueueSummary(summary);
  } catch (err) {
    console.error("Failed to load queue", err);
  }
}

function buildQueueSummary(queue) {
  const summary = {
    total: Array.isArray(queue) ? queue.length : 0,
    runnable: 0,
    waiting: 0,
    blocked: 0,
    byCategory: [],
  };

  const categories = new Map();
  (queue || []).forEach((action) => {
    if (action.status === "blocked") {
      summary.blocked += 1;
    } else if (action.status === "approved" && action.runnable) {
      summary.runnable += 1;
    } else if (action.status === "approved") {
      summary.waiting += 1;
    }

    if (action.fail_category) {
      categories.set(
        action.fail_category,
        (categories.get(action.fail_category) || 0) + 1,
      );
    }
  });

  summary.byCategory = [...categories.entries()].map(
    ([fail_category, count]) => ({
      fail_category,
      count,
    }),
  );

  return summary;
}

function renderQueueSummary(summary) {
  if (!queueSummary) return;

  const total = Number(summary?.total || 0);
  const runnable = Number(summary?.runnable || 0);
  const waiting = Number(summary?.waiting || 0);
  const blocked = Number(summary?.blocked || 0);
  const categories = Array.isArray(summary?.byCategory)
    ? summary.byCategory
    : [];

  if (retryAllBtn) retryAllBtn.style.display = total > 0 ? "flex" : "none";
  if (retryWaitingBtn)
    retryWaitingBtn.style.display = waiting > 0 ? "flex" : "none";
  if (retryBlockedBtn)
    retryBlockedBtn.style.display = blocked > 0 ? "flex" : "none";
  updateSelectedRetryButton();

  if (total === 0) {
    queueSummary.innerHTML = "No queued actions.";
    return;
  }

  const categoryButtons =
    categories.length > 0
      ? categories
          .map(
            (entry) => `
          <button class="retry-category-btn inline-flex items-center gap-1 rounded-full border border-outline-variant bg-surface-container px-3 py-1 text-[11px] font-semibold text-on-surface-variant hover:border-primary hover:text-primary transition-colors" data-category="${escapeHtml(entry.fail_category)}">
            Retry ${escapeHtml(entry.fail_category)} (${entry.count})
          </button>`,
          )
          .join("")
      : '<span class="text-body-xs text-on-surface-variant">No categorized failures yet.</span>';

  queueSummary.innerHTML = `
    <div class="flex flex-wrap items-center gap-3">
      <span class="font-semibold text-on-surface">Queue summary</span>
      <span>${runnable} runnable</span>
      <span>${waiting} waiting</span>
      <span>${blocked} blocked</span>
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${categoryButtons}
    </div>
  `;
}

function renderRunSummary(summary) {
  if (!postRunBanner || !postRunBannerText || !postRunBannerMeta) return;

  const parts = [];
  if (Number(summary?.successes || 0) > 0) {
    parts.push(
      `<span class="rounded-full bg-green-50 px-2 py-1 text-xs font-semibold text-green-700">${summary.successes} sent</span>`,
    );
  }
  if (Number(summary?.failures || 0) > 0) {
    parts.push(
      `<span class="rounded-full bg-error-container px-2 py-1 text-xs font-semibold text-error">${summary.failures} failed</span>`,
    );
  }
  if (Number(summary?.skipped || 0) > 0) {
    parts.push(
      `<span class="rounded-full bg-surface-container-high px-2 py-1 text-xs font-semibold text-on-surface-variant">${summary.skipped} skipped</span>`,
    );
  }
  if (Number(summary?.waitingCount || 0) > 0) {
    parts.push(
      `<span class="rounded-full bg-secondary-container px-2 py-1 text-xs font-semibold text-on-secondary-container">${summary.waitingCount} waiting</span>`,
    );
  }
  if (Number(summary?.blockedCount || 0) > 0) {
    parts.push(
      `<span class="rounded-full bg-error-container px-2 py-1 text-xs font-semibold text-error">${summary.blockedCount} blocked</span>`,
    );
  }

  postRunBannerText.textContent =
    summary?.message || "Automation run completed.";
  postRunBannerMeta.innerHTML = parts.join("");
  postRunBanner.hidden = false;
}

function renderQueueGroup(title, toneClass, items) {
  if (!items.length) return "";

  const headerClass = toneClass || "bg-surface-container-low";
  const rows = items.map((action) => renderQueueRow(action)).join("");

  return `
    <tr class="${headerClass}">
      <td colspan="6" class="px-4 py-2 font-label-caps text-label-caps text-on-surface-variant border-b border-outline-variant">
        ${title} (${items.length})
      </td>
    </tr>
    ${rows}
  `;
}

function renderQueueRow(action) {
  const leadName = escapeHtml(action.lead_name || "Unknown");
  const platform = escapeHtml(action.platform || "");
  const actionType = ["connect", "connection", "connections"].includes(action.action_type)
    ? "Connect"
    : ["follow", "follows"].includes(action.action_type)
      ? "Follow"
      : "DM";
  const isBlocked = action.status === "blocked";
  const isWaiting = action.status === "approved" && !action.runnable;
  const statusLabel = isBlocked
    ? "Blocked"
    : isWaiting
      ? "Waiting"
      : "Runnable";
  const statusDot = isBlocked
    ? "bg-error border-error"
    : isWaiting
      ? "bg-secondary border-secondary"
      : "bg-primary border-primary";
  const statusTone = isBlocked
    ? "text-error"
    : isWaiting
      ? "text-secondary"
      : "text-primary";
  const categoryBadge = action.fail_category
    ? `<span class="inline-flex rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">${escapeHtml(action.fail_category)}</span>`
    : "";
  const retryCount = Number(action.retry_count || 0);
  const retryLabel =
    retryCount > 0
      ? `<span class="text-[11px] text-on-surface-variant">attempt ${retryCount}/3</span>`
      : "";
  const snoozeLabel =
    isWaiting && action.snooze_until
      ? `<span class="text-[11px] text-secondary">Retry after ${formatDateTime(action.snooze_until)}</span>`
      : "";
  const errorLabel = action.last_error
    ? `<div class="text-[11px] text-on-surface-variant max-w-[280px] truncate" title="${escapeHtml(action.last_error)}">${escapeHtml(action.last_error)}</div>`
    : "";

  return `
    <tr class="h-table-row-height border-b border-outline-variant/50 hover:bg-surface-variant/10 transition-colors group" data-id="${action.message_id}" data-status="${action.status || "approved"}">
      <td class="px-4 py-3 align-top">
        <input class="queue-retry-checkbox" data-id="${action.message_id}" type="checkbox" ${selectedRetryIds.has(Number(action.message_id)) ? "checked" : ""} title="Select for retry" />
      </td>
      <td class="px-4 py-3 align-top font-medium">${leadName}</td>
      <td class="px-4 py-3 align-top text-on-surface-variant capitalize">${platform}</td>
      <td class="px-4 py-3 align-top">${actionType}</td>
      <td class="px-4 py-3 align-top status-cell">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${statusDot} inline-block border"></span>
          <span class="${statusTone}">${statusLabel}</span>
        </div>
        <div class="mt-1 flex flex-col gap-1">
          ${categoryBadge}
          ${retryLabel}
          ${snoozeLabel}
          ${errorLabel}
        </div>
      </td>
      <td class="px-4 py-3 align-top text-right">
        <div class="opacity-0 group-hover:opacity-100 transition-opacity flex justify-end gap-1">
          ${
            isBlocked || isWaiting
              ? `
            <button class="p-1 text-secondary hover:text-surface-tint rounded transition-colors retry-btn" data-id="${action.message_id}" title="Retry">
              <span class="material-symbols-outlined text-[18px]">replay</span>
            </button>
          `
              : ""
          }
          <button class="p-1 text-secondary hover:text-surface-tint rounded transition-colors skip-btn" data-id="${action.message_id}" title="Skip">
            <span class="material-symbols-outlined text-[18px]">skip_next</span>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderQueue(queue) {
  if (!queue || queue.length === 0) {
    queueBody.innerHTML = "";
    if (emptyState) emptyState.classList.add("visible");
    return;
  }

  if (emptyState) emptyState.classList.remove("visible");

  const runnable = queue.filter((action) => action.runnable);
  const waiting = queue.filter(
    (action) => action.status === "approved" && !action.runnable,
  );
  const blocked = queue.filter((action) => action.status === "blocked");

  queueBody.innerHTML = [
    renderQueueGroup("Runnable", "bg-surface-container-lowest", runnable),
    renderQueueGroup("Waiting", "bg-surface-container-low", waiting),
    renderQueueGroup("Blocked", "bg-error-container/40", blocked),
  ]
    .filter(Boolean)
    .join("");
}

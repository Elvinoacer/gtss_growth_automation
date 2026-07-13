/* ================================================================
   Automation Control – Frontend Logic
   ================================================================ */

(function () {
  "use strict";

  const { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

  // State
  let activeJobId = null;
  let isAutomationRunning = false;
  let socketSub = null;
  let sessionStatus = {}; // { platform: bool } — true = session active
  let cachedLimits = null; // last loaded limits object, used for re-render

  // DOM Refs
  const runAllBtn = document.getElementById("run-all-btn");
  const stopBtn = document.getElementById("stop-btn");
  const queueBody = document.getElementById("queue-body");
  const logContainer = document.getElementById("log-container");
  const logAutoScroll = document.getElementById("log-autoscroll");
  const logClearBtn = document.getElementById("log-clear-btn");
  const emptyState = document.getElementById("empty-state");
  const limitCards = document.getElementById("limit-cards");
  const queueSummary = document.getElementById("queue-summary");
  const postRunBanner = document.getElementById("post-run-banner");
  const postRunBannerText = document.getElementById("post-run-banner-text");
  const postRunBannerMeta = document.getElementById("post-run-banner-meta");
  const retryAllBtn = document.getElementById("retry-all-btn");
  const retrySelectedBtn = document.getElementById("retry-selected-btn");
  const queueSelectAll = document.getElementById("queue-select-all");
  const retryWaitingBtn = document.getElementById("retry-waiting-btn");
  const retryBlockedBtn = document.getElementById("retry-blocked-btn");

  const captchaBanner = document.getElementById("captcha-banner");
  const captchaPlatformText = document.getElementById("captcha-platform-text");
  const manualOpenBtn = document.getElementById("manual-open-btn");
  const manualResumeBtn = document.getElementById("manual-resume-btn");
  let currentCaptchaPlatform = null;
  let selectedRetryIds = new Set();

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------

  async function init() {
    await loadSessionStatus();
    await loadLimits();
    await loadQueue();
    if (postRunBanner) postRunBanner.hidden = true;

    // Start idle-mode background polling to keep data fresh
    startPolling(POLL_IDLE_MS);

    // Surface warnings for any expired sessions (status already fetched)
    for (const [platform, isValid] of Object.entries(sessionStatus)) {
      if (!isValid) {
        showToast(
          `No valid session for ${platform}. Please authenticate.`,
          "warn",
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // Session Status
  // ----------------------------------------------------------------

  async function loadSessionStatus() {
    try {
      const data = await fetchJSON("/api/sessions/status");
      sessionStatus = data || {};
      // If limits are already loaded, re-render cards so badges update live
      if (cachedLimits) {
        renderLimitCards(cachedLimits);
      }
    } catch (err) {
      console.error("Failed to load session status", err);
    }
  }

  // ----------------------------------------------------------------
  // Load Limits
  // ----------------------------------------------------------------

  async function loadLimits() {
    try {
      const data = await fetchJSON("/api/automation/limits");
      cachedLimits = data;
      renderLimitCards(data);
    } catch (err) {
      console.error("Failed to load limits", err);
    }
  }

  function renderLimitCards(limitsObj) {
    if (!limitCards) return;

    limitCards.innerHTML = "";
    const icons = {
      linkedin: "work",
      x: "tag",
      facebook: "groups",
      instagram: "photo_camera",
    };

    const colors = {
      linkedin: "primary-container",
      x: "on-surface",
      facebook: "secondary",
      instagram: "tertiary",
    };

    for (const [platform, counts] of Object.entries(limitsObj)) {
      const icon = icons[platform] || "web";
      const bgClass = colors[platform] || "primary";
      const pct =
        counts.limit > 0
          ? Math.min(100, Math.round((counts.used / counts.limit) * 100))
          : 0;

      const isActive = !!sessionStatus[platform];

      // Status badge next to the platform name
      const statusBadge = isActive
        ? `<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-green-500">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>
            Active
          </span>`
        : `<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-error">
            <span class="w-1.5 h-1.5 rounded-full bg-error inline-block"></span>
            Expired
          </span>`;

      // Subtle red border for expired sessions
      const borderClass = isActive
        ? "border-outline-variant"
        : "border-error/30";

      // Auth control: small icon for active, prominent Login button for expired
      const authControl = isActive
        ? `<button class="auth-btn p-1 rounded text-outline hover:text-primary hover:bg-surface-variant/50 transition-colors" data-platform="${platform}" title="Re-authenticate ${platform}" type="button">
            <span class="material-symbols-outlined text-base">login</span>
          </button>`
        : `<button class="auth-btn inline-flex items-center gap-1 rounded bg-error/15 border border-error/50 px-2 py-0.5 text-[11px] font-bold text-error hover:bg-error/25 transition-colors" data-platform="${platform}" title="Authenticate ${platform}" type="button">
            <span class="material-symbols-outlined text-[14px]">login</span>
            Login
          </button>`;

      const card = `
        <div class="bg-surface-container-lowest border ${borderClass} shadow-sm rounded-lg p-4 flex flex-col justify-between min-h-32 relative overflow-hidden">
          <div class="flex justify-between items-start gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-label-caps text-label-caps text-on-surface-variant capitalize truncate">${platform}</span>
              ${statusBadge}
            </div>
            <div class="flex items-center gap-1 shrink-0">
              ${authControl}
              <span class="material-symbols-outlined text-${bgClass} text-lg">${icon}</span>
            </div>
          </div>
          <div class="mt-2">
            <div class="text-on-surface flex items-baseline gap-1" style="font-size:20px;font-weight:700;line-height:1.25">
                ${counts.used} <span class="text-[12px] text-on-surface-variant font-normal">/ ${counts.limit}</span>
            </div>
            <div class="w-full h-1.5 bg-surface-container-high rounded-full mt-2 overflow-hidden">
                <div class="h-full bg-${bgClass} rounded-full transition-all" style="width: ${pct}%"></div>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2 text-[11px] text-on-surface-variant">
            <label class="flex items-center gap-1">DM limit
              <input class="automation-limit-input w-14 rounded border border-outline-variant bg-surface px-2 py-0.5 text-on-surface" data-limit-platform="${platform}" data-limit-action="dms" type="number" min="1" max="1000" value="${counts.dmsLimit || 1}" />
            </label>
            <button class="save-limit-btn rounded border border-outline-variant px-2 py-0.5 hover:border-primary hover:text-primary" data-platform="${platform}" type="button">Save</button>
          </div>
        </div>
      `;
      limitCards.insertAdjacentHTML("beforeend", card);
    }
  }

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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateTime(value) {
    const parsed = new Date(String(value).replace(" ", "T"));
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ----------------------------------------------------------------
  // Logging
  // ----------------------------------------------------------------

  function appendLog(type, msg, data = {}) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    let typeClass = "text-primary-fixed-dim";
    if (type === "error" || type === "captcha") typeClass = "text-error";
    else if (type === "warn") typeClass = "text-secondary-fixed-dim";
    else if (type === "done") typeClass = "text-primary";

    const div = document.createElement("div");
    div.className = "flex gap-3 mb-1.5";
    div.innerHTML = `
      <span class="text-outline shrink-0">[${time}]</span>
      <span class="${typeClass} shrink-0 w-12 font-bold">${type.toUpperCase()}</span>
      <span class="text-inverse-on-surface">${msg}</span>
    `;

    logContainer.appendChild(div);

    if (logAutoScroll.checked) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  logClearBtn.addEventListener("click", () => {
    logContainer.innerHTML = "";
  });

  // ----------------------------------------------------------------
  // Automation Execution
  // ----------------------------------------------------------------

  async function startAutomation() {
    if (isAutomationRunning) return;

    // Clear captcha warning if visible
    captchaBanner.style.display = "none";
    if (postRunBanner) postRunBanner.hidden = true;

    try {
      const res = await fetchJSON("/api/automation/run", { method: "POST" });
      activeJobId = res.jobId;
      isAutomationRunning = true;
      runAllBtn.disabled = true;
      runAllBtn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[18px]">refresh</span> <span class="truncate max-w-[200px]">Starting...</span>`;
      stopBtn.style.display = "flex";

      appendLog("info", "Connected to real-time execution stream...");

      // Connect SSE just to trigger the executor (backend needs it)
      const legacySSE = window.gtss.initSSE(`/api/automation/stream/${activeJobId}`, () => {});

      // Listen for all automation events via Socket.IO
      function onAutomationLog(event) {
        if (!event) return;
        appendLog(event.type, event.message, event);

        if (event.type === "captcha") {
          showCaptchaWarning(event.platform);
        }

        if (event.type === "state") {
          runAllBtn.innerHTML = `<span class="material-symbols-outlined animate-spin text-[18px]">refresh</span> <span class="truncate max-w-[200px]">${event.message}</span>`;
        }

        if (event.type === "done") {
          renderRunSummary(event);
          finishRun();
        }

        if (event.type === "error" && !event.message?.includes("Processing")) {
          // Only finish on terminal errors, not per-action errors
          if (event.message?.includes("Executor error") || event.message?.includes("stopped by user")) {
            finishRun();
          }
        }
      }

      function onAutomationRefresh() {
        loadLimits();
        loadQueue();
      }

      function onQueueUpdate() {
        loadQueue();
      }

      const socket = getSocket();
      if (socket) {
        socket.on('automation:log', onAutomationLog);
        socket.on('automation:refresh', onAutomationRefresh);
        socket.on('automation:queue', onQueueUpdate);
      }

      function finishRun() {
        if (legacySSE) legacySSE.close();
        if (socket) {
          socket.off('automation:log', onAutomationLog);
          socket.off('automation:refresh', onAutomationRefresh);
          socket.off('automation:queue', onQueueUpdate);
        }
        isAutomationRunning = false;
        activeJobId = null;
        runAllBtn.disabled = false;
        runAllBtn.innerHTML = `<span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1">play_arrow</span> Run Queue`;
        stopBtn.style.display = "none";
        loadQueue();
        loadLimits();
      }
    } catch (err) {
      showToast(err.message, "error");
      appendLog("error", err.message);
    }
  }

  async function stopAutomation() {
    if (!activeJobId) return;

    try {
      await fetchJSON(`/api/automation/stop/${activeJobId}`, {
        method: "POST",
      });
      appendLog("warn", "Stop signal sent.");
      stopBtn.disabled = true;
      stopBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">refresh</span> Stopping…`;
      setTimeout(() => {
        if (stopBtn.disabled) {
          stopBtn.disabled = false;
          stopBtn.innerHTML = `<span class="material-symbols-outlined">stop_circle</span> Stop`;
          showToast(
            "Stop signal sent — automation will halt after the current action.",
            "warn",
          );
        }
      }, 10_000);
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  runAllBtn.addEventListener("click", startAutomation);
  stopBtn.addEventListener("click", stopAutomation);

  // ----------------------------------------------------------------
  // Skip Action
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

  limitCards?.addEventListener("click", async (e) => {
    const saveBtn = e.target.closest(".save-limit-btn");
    if (!saveBtn) return;
    const platform = saveBtn.dataset.platform;
    const input = document.querySelector(`[data-limit-platform="${platform}"][data-limit-action="dms"]`);
    try {
      await fetchJSON("/api/automation/limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [platform]: { dms: Number(input.value) } }),
      });
      showToast(`${platform} DM limit saved`, "success");
      await loadLimits();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  if (queueSummary) {
    queueSummary.addEventListener("click", async (e) => {
      const categoryBtn = e.target.closest(".retry-category-btn");
      if (!categoryBtn) return;
      await retryQueue("all", categoryBtn.dataset.category);
    });
  }

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

  // ----------------------------------------------------------------
  // Authentication & Captcha
  // ----------------------------------------------------------------

  limitCards.addEventListener("click", async (e) => {
    const authBtn = e.target.closest(".auth-btn");
    if (!authBtn) return;

    const platform = authBtn.dataset.platform;
    showToast(`Opening browser to authenticate ${platform}...`, "info");
    appendLog("info", `Manual authentication requested for ${platform}`);

    try {
      await fetchJSON(`/api/sessions/authenticate/${platform}`, {
        method: "POST",
      });
      showToast(`${platform} authenticated successfully!`, "success");
      appendLog("done", `${platform} authenticated`);
      // Refresh session status — re-renders limit cards with updated badge
      await loadSessionStatus();
    } catch (err) {
      showToast(`Auth failed: ${err.message}`, "error");
      appendLog("error", `Auth failed: ${err.message}`);
    }
  });

  function showCaptchaWarning(platform) {
    currentCaptchaPlatform = platform;
    captchaPlatformText.textContent = platform;
    captchaBanner.style.display = "flex";
  }

  manualOpenBtn.addEventListener("click", async () => {
    if (!currentCaptchaPlatform) return;
    try {
      showToast(
        `Opening visible browser for ${currentCaptchaPlatform}`,
        "info",
      );
      await fetchJSON(
        `/api/automation/open-browser/${currentCaptchaPlatform}`,
        { method: "POST" },
      );
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  manualResumeBtn.addEventListener("click", () => {
    captchaBanner.style.display = "none";
    currentCaptchaPlatform = null;
    startAutomation(); // Resumes run
  });

  // Hide stop btn and captcha banner initially
  stopBtn.style.display = "none";
  captchaBanner.style.display = "none";

  // Global socket listeners — always active for passive real-time updates
  const socket = getSocket();
  if (socket) {
    socket.on('automation:queue', () => {
      loadQueue();
      loadLimits();
    });
  }

  // Run init
  init();
})();

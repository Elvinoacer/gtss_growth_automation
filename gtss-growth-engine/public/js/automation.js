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
  const retryWaitingBtn = document.getElementById("retry-waiting-btn");
  const retryBlockedBtn = document.getElementById("retry-blocked-btn");

  const captchaBanner = document.getElementById("captcha-banner");
  const captchaPlatformText = document.getElementById("captcha-platform-text");
  const manualOpenBtn = document.getElementById("manual-open-btn");
  const manualResumeBtn = document.getElementById("manual-resume-btn");
  let currentCaptchaPlatform = null;

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------

  async function init() {
    await loadLimits();
    await loadQueue();
    if (postRunBanner) postRunBanner.hidden = true;

    // Start idle-mode background polling to keep data fresh
    startPolling(POLL_IDLE_MS);

    // Re-check sessions
    const sessions = await fetchJSON("/api/sessions/status");
    for (const [platform, isValid] of Object.entries(sessions)) {
      if (!isValid) {
        showToast(
          `No valid session for ${platform}. Please authenticate.`,
          "warn",
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // Load Limits
  // ----------------------------------------------------------------

  async function loadLimits() {
    try {
      const data = await fetchJSON("/api/automation/limits");
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

      const card = `
        <div class="bg-surface-container-lowest border border-outline-variant shadow-sm rounded-lg p-5 flex flex-col justify-between h-32 relative overflow-hidden">
          <div class="flex justify-between items-start">
            <span class="font-label-caps text-label-caps text-on-surface-variant capitalize">${platform}</span>
            <span class="material-symbols-outlined text-${bgClass} text-lg">${icon}</span>
          </div>
          <div class="mt-2">
            <div class="font-display-lg text-display-lg text-on-surface flex items-baseline gap-1">
                ${counts.used} <span class="font-body-sm text-body-sm text-on-surface-variant font-normal">/ ${counts.limit}</span>
            </div>
            <div class="w-full h-1.5 bg-surface-container-high rounded-full mt-3 overflow-hidden">
                <div class="h-full bg-${bgClass} rounded-full transition-all" style="width: ${pct}%"></div>
            </div>
          </div>
          <button class="absolute top-4 right-10 text-outline hover:text-primary transition-colors auth-btn" data-platform="${platform}" title="Authenticate">
            <span class="material-symbols-outlined text-sm">login</span>
          </button>
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

  function renderQueueGroup(title, toneClass, items) {
    if (!items.length) return "";

    const headerClass = toneClass || "bg-surface-container-low";
    const rows = items.map((action) => renderQueueRow(action)).join("");

    return `
      <tr class="${headerClass}">
        <td colspan="5" class="px-4 py-2 font-label-caps text-label-caps text-on-surface-variant border-b border-outline-variant">
          ${title} (${items.length})
        </td>
      </tr>
      ${rows}
    `;
  }

  function renderQueueRow(action) {
    const leadName = escapeHtml(action.lead_name || "Unknown");
    const platform = escapeHtml(action.platform || "");
    const actionType = action.action_type === "connect" ? "Connect" : "DM";
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
      stopBtn.innerHTML = `<span class="material-symbols-outlined animate-spin">refresh</span> Stopping...`;
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

  if (queueSummary) {
    queueSummary.addEventListener("click", async (e) => {
      const categoryBtn = e.target.closest(".retry-category-btn");
      if (!categoryBtn) return;
      await retryQueue("all", categoryBtn.dataset.category);
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

async function fetchJSON(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  // Auto-set Content-Type for JSON bodies so callers don't have to
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      // Non-JSON response — keep data null and fall through to the
      // error path with the raw text as the message.
    }
  }

  if (!response.ok) {
    const message =
      data && data.error ? data.error : `Request failed: ${response.status}`;
    const err = new Error(message);
    // Attach the full response body and status so callers can inspect
    // structured error fields like `hint`, `active_execution_id`, etc.
    err.status = response.status;
    err.body = data || {};
    err.hint = (data && data.hint) || null;
    throw err;
  }

  return data;
}

function showToast(message, type = "info", duration = 4000) {
  // Pick an icon per type so the user gets an immediate visual signal of
  // severity without having to read the message. This is especially
  // helpful for error toasts that may stack up after a failed action.
  const icons = {
    success: "✓",
    error: "✕",
    warning: "⚠",
    warn: "⚠",
    info: "ℹ",
  };
  const icon = icons[type] || icons.info;

  const toast = document.createElement("div");
  toast.className = `gtss-toast ${type}`;
  // Sync the progress-bar animation with the actual duration so the bar
  // doesn't finish early on long-lived error toasts (the previous default
  // was a fixed 4000ms regardless of the `duration` argument).
  toast.style.setProperty("--toast-duration", `${duration}ms`);
  toast.innerHTML = `
    <span class="gtss-toast__icon" aria-hidden="true">${icon}</span>
    <span class="gtss-toast__msg">${escapeHtml(message)}</span>
    <span class="toast-progress" aria-hidden="true"></span>
    <button class="gtss-toast__close" type="button" aria-label="Dismiss notification">✕</button>
  `;
  document.body.appendChild(toast);

  // Stack: nudge this toast above any others currently visible so multiple
  // toasts don't overlap into an unreadable blob.
  relayoutToasts();

  // Click anywhere on the toast (or the explicit close button) dismisses
  // it early — important for long-lived error toasts.
  const dismiss = () => {
    toast.classList.remove("visible");
    window.setTimeout(() => {
      toast.remove();
      relayoutToasts();
    }, 220);
  };
  toast.addEventListener("click", (e) => {
    // Avoid double-handling when the close button is the click target.
    if (e.target.closest(".gtss-toast__close")) return;
    dismiss();
  });
  toast.querySelector(".gtss-toast__close").addEventListener("click", dismiss);

  requestAnimationFrame(() => toast.classList.add("visible"));
  window.setTimeout(dismiss, duration);
}

/**
 * Re-position all visible toasts so they stack vertically without
 * overlapping. Called whenever a toast is added or removed.
 */
function relayoutToasts() {
  const toasts = Array.from(document.querySelectorAll(".gtss-toast.visible"));
  // Also include toasts that are mid-removal so a freshly-added toast
  // doesn't briefly overlap one that's fading out.
  const all = Array.from(document.querySelectorAll(".gtss-toast"));
  let offset = 0;
  all.forEach((t) => {
    t.style.setProperty("--toast-stack-offset", `${offset}px`);
    offset += t.offsetHeight + 12;
  });
}

/**
 * Show a styled, Promise-based confirmation dialog and resolve with the
 * user's choice (true = confirmed, false = cancelled).
 *
 * This replaces the jarring native `confirm()` calls used across the
 * pipeline page (Stop / Restart / Force-Clear). The native dialog blocks
 * the main thread, can't be styled, and gives no visual hierarchy for
 * destructive actions. This version:
 *   - matches the dark glassmorphism theme of the rest of the app
 *   - supports a title + multi-line body
 *   - supports a `danger` flag that turns the confirm button red
 *   - supports custom confirm/cancel labels
 *   - closes on Escape and on backdrop click (cancel)
 *   - auto-focuses the confirm button so Enter works immediately
 *
 * @param {object} opts
 * @param {string} opts.title - Short headline.
 * @param {string} opts.body  - Detailed explanation (may contain \n).
 * @param {string} [opts.confirmLabel='Confirm'] - Confirm button text.
 * @param {string} [opts.cancelLabel='Cancel']   - Cancel button text.
 * @param {boolean} [opts.danger=false]          - Red confirm button for destructive actions.
 * @param {string} [opts.icon]                   - Optional emoji icon shown next to the title.
 * @returns {Promise<boolean>}
 */
function showConfirmDialog({
  title,
  body = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  icon = "",
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "gtss-confirm-overlay gtss-confirm-overlay--dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "gtss-dialog-title");

    const bodyHtml = escapeHtml(body).replace(/\n/g, "<br/>");

    overlay.innerHTML = `
      <div class="gtss-confirm-modal gtss-confirm-modal--dialog${danger ? " gtss-confirm-modal--danger" : ""}">
        <div class="gtss-confirm-modal__head">
          ${icon ? `<span class="gtss-confirm-modal__icon" aria-hidden="true">${icon}</span>` : ""}
          <h3 id="gtss-dialog-title" class="gtss-confirm-modal__title">${escapeHtml(title || "Please confirm")}</h3>
        </div>
        ${body ? `<div class="gtss-confirm-modal__body">${bodyHtml}</div>` : ""}
        <div class="gtss-confirm-modal__actions">
          <button type="button" class="gtss-btn gtss-btn--ghost gtss-confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="gtss-btn ${danger ? "gtss-btn--danger" : "gtss-btn--primary"} gtss-confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove("visible");
      window.setTimeout(() => overlay.remove(), 180);
      resolve(val);
    };

    // Animate in.
    requestAnimationFrame(() => overlay.classList.add("visible"));

    const cancelBtn = overlay.querySelector(".gtss-confirm-cancel");
    const okBtn = overlay.querySelector(".gtss-confirm-ok");

    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));

    // Backdrop click = cancel.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });

    // Escape = cancel.
    const onKey = (e) => {
      if (e.key === "Escape") {
        finish(false);
        document.removeEventListener("keydown", onKey);
      } else if (e.key === "Enter") {
        finish(true);
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);

    // Auto-focus the confirm button so keyboard users can press Enter.
    requestAnimationFrame(() => okBtn.focus());
  });
}

function initSSE(url, onMessage) {
  let source;
  let closed = false;
  let retryTimer;

  function connect() {
    source = new EventSource(url);
    source.onmessage = (event) => {
      const data = event.data ? JSON.parse(event.data) : null;
      onMessage(data);
    };
    source.onerror = () => {
      source.close();
      if (!closed) {
        showToast("Connection lost. Attempting to reconnect...", "warning");
        retryTimer = window.setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return {
    close() {
      closed = true;
      window.clearTimeout(retryTimer);
      if (source) {
        source.close();
      }
    },
  };
}

// ----------------------------------------------------------------
// Socket.IO — Global real-time connection
// ----------------------------------------------------------------

let _socket = null;

function getSocket() {
  if (!_socket && typeof io !== "undefined") {
    _socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      transports: ["websocket", "polling"],
    });

    _socket.on("connect", () => {
      console.log("[GTSS] Socket.IO connected:", _socket.id);
    });

    _socket.on("disconnect", (reason) => {
      console.warn("[GTSS] Socket.IO disconnected:", reason);
    });

    _socket.on("connect_error", (err) => {
      console.warn("[GTSS] Socket.IO connection error:", err.message);
    });

    // Live updates for global UI elements
    _socket.on("stats:updated", () => {
      updateActionBadge();
    });

    _socket.on("sessions:updated", () => {
      updateSessionDots();
    });
  }
  return _socket;
}

/**
 * Subscribe to socket events. Returns an object with .off() to unsubscribe.
 * @param {Object.<string, Function>} eventMap - { 'event:name': handler }
 */
function initSocket(eventMap) {
  const socket = getSocket();
  if (!socket) {
    console.warn("[GTSS] Socket.IO not available, falling back to polling");
    return { off() {} };
  }

  const entries = Object.entries(eventMap);
  entries.forEach(([event, handler]) => {
    socket.on(event, handler);
  });

  return {
    off() {
      entries.forEach(([event, handler]) => {
        socket.off(event, handler);
      });
    },
    socket,
  };
}

/**
 * Subscribe to a room for targeted events.
 */
function joinRoom(room) {
  const socket = getSocket();
  if (socket) socket.emit("subscribe", room);
}

function leaveRoom(room) {
  const socket = getSocket();
  if (socket) socket.emit("unsubscribe", room);
}

async function updateSessionDots() {
  try {
    const statuses = await fetchJSON("/api/sessions/status");
    Object.entries(statuses).forEach(([platform, isActive]) => {
      const dot = document.querySelector(`[data-platform-dot="${platform}"]`);
      const row = document.querySelector(`[data-platform-row="${platform}"]`);
      if (dot) {
        dot.classList.toggle("active", Boolean(isActive));
      }
      if (row) {
        row.classList.toggle("active", Boolean(isActive));
        const pill = row.querySelector(".gtss-session-pill");
        if (pill) {
          pill.textContent = isActive ? "Connected" : "Offline";
        }
      }
    });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function updateActionBadge() {
  const badge = document.getElementById("gtss-action-badge");
  if (!badge) {
    return;
  }

  try {
    const stats = await fetchJSON("/api/stats/daily-actions");
    const limit = stats.limit || 0;
    const used = stats.used || 0;
    const ratio = limit > 0 ? used / limit : 0;

    badge.textContent = `Actions today: ${used} / ${limit} limit`;
    badge.style.setProperty("--action-ratio", `${Math.min(Math.round(ratio * 100), 100)}%`);
    badge.classList.toggle("warning", ratio >= 0.7 && ratio < 0.9);
    badge.classList.toggle("danger", ratio >= 0.9);

    const dashboardBadge = document.getElementById("nav-badge-dashboard");
    if (dashboardBadge) {
      dashboardBadge.textContent = limit ? `${Math.min(Math.round(ratio * 100), 100)}%` : "";
    }
  } catch (error) {
    badge.textContent = "Actions today: unavailable";
    badge.style.setProperty("--action-ratio", "100%");
    badge.classList.add("danger");
  }
}

function formatPlatformLabel(platform) {
  const key = String(platform || "")
    .trim()
    .toLowerCase();
  if (!key) return "";
  if (key === "linkedin") return "LinkedIn";
  if (key === "x") return "X";
  if (key === "instagram") return "Instagram";
  if (key === "facebook") return "Facebook";

  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function loadPlatformCatalog() {
  try {
    const data = await fetchJSON("/api/platforms");
    return Array.isArray(data.platforms) ? data.platforms : [];
  } catch (error) {
    return [];
  }
}

function initShell() {
  const sidebar = document.getElementById("gtss-sidebar");
  const toggle = document.getElementById("gtss-sidebar-toggle");
  const pageTitle = document.getElementById("gtss-page-title");
  const notificationButton = document.getElementById(
    "gtss-notification-button",
  );
  const notificationDropdown = document.getElementById(
    "gtss-notification-dropdown",
  );
  const storedCollapsed =
    localStorage.getItem("gtss.sidebar.collapsed") === "true";

  if (sidebar && storedCollapsed) {
    sidebar.classList.add("collapsed");
    document.body.classList.add("gtss-sidebar-collapsed");
  }

  if (pageTitle && document.body.dataset.pageTitle) {
    pageTitle.textContent = document.body.dataset.pageTitle;
  }

  const pageSubtitle = document.getElementById("gtss-page-subtitle");
  if (pageSubtitle) {
    const subtitles = {
      Dashboard: "Live command center for growth operations",
      "Lead Discovery": "Find, filter, and route new prospects",
      Qualification: "Score leads and prioritize outreach",
      "Lead Qualification": "Score leads and prioritize outreach",
      "Message Generator": "Generate and review campaign-ready messaging",
      Automation: "Control sessions, queues, and safety limits",
      Campaigns: "Manage active outreach sequences",
      "CRM Pipeline": "Track opportunities from reply to close",
      "Content Scheduler": "Plan posts and campaign assets",
      Pipelines: "Schedule repeatable growth workflows",
      Monitoring: "Observe throughput, health, and failures",
      Settings: "Configure channels, AI, limits, and security",
      "Asset Library": "Organize reusable creative and copy",
      "Audit Log": "Review operator and automation activity",
      "Instagram Warmup": "Safely warm Instagram leads before outreach",
    };
    pageSubtitle.textContent = subtitles[document.body.dataset.pageTitle] || "Operator console ready";
  }

  document.querySelectorAll(".gtss-nav__link").forEach((link) => {
    const route = link.dataset.route;
    const active =
      route === "/"
        ? window.location.pathname === "/"
        : window.location.pathname.startsWith(route);
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  if (toggle && sidebar) {
    const syncToggleAria = (collapsed) => {
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute(
        "aria-label",
        collapsed ? "Expand sidebar" : "Collapse sidebar",
      );
      toggle.setAttribute("title", collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)");
    };
    syncToggleAria(sidebar.classList.contains("collapsed"));
    toggle.addEventListener("click", () => {
      const collapsed = !sidebar.classList.contains("collapsed");
      sidebar.classList.toggle("collapsed", collapsed);
      document.body.classList.toggle("gtss-sidebar-collapsed", collapsed);
      localStorage.setItem("gtss.sidebar.collapsed", String(collapsed));
      syncToggleAria(collapsed);
    });
    // Keyboard shortcut: Ctrl/Cmd + B toggles the sidebar.
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle.click();
      }
    });
  }

  // Sidebar version display (best-effort, non-blocking).
  const sidebarVersion = document.getElementById("gtss-sidebar-version");
  if (sidebarVersion) {
    window
      .gtss?.fetchJSON?.("/api/settings")
      .then((data) => {
        if (data && data.appVersion) {
          sidebarVersion.textContent = `v${data.appVersion}`;
        }
      })
      .catch(() => {
        /* silent — version is a nicety, not critical */
      });
  }

  if (notificationButton && notificationDropdown) {
    notificationButton.addEventListener("click", () => {
      const isOpen = notificationDropdown.classList.toggle("open");
      notificationButton.setAttribute("aria-expanded", String(isOpen));
    });
    document.addEventListener("click", (event) => {
      if (
        !notificationDropdown.contains(event.target) &&
        !notificationButton.contains(event.target)
      ) {
        notificationDropdown.classList.remove("open");
        notificationButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  updateSessionDots();
  updateActionBadge();

  // Initialize socket connection on DOMContentLoaded
  getSocket();

  // Fallback polling only if socket isn't available (reduced frequency)
  window.setInterval(updateSessionDots, 120000);
  window.setInterval(updateActionBadge, 120000);
}

function renderPlatformBadge(platform) {
  return `<span class="platform-badge platform-${platform}">${formatPlatformLabel(platform) || platform}</span>`;
}

function renderStatusBadge(status) {
  const label = String(status || "unknown").replaceAll("_", " ");
  const statusClass =
    {
      qualified: "success",
      converted: "success",
      meeting_booked: "success",
      discovered: "info",
      pending: "warning",
      pending_qualification: "warning",
      approved: "warning",
      messaged: "info",
      replied: "info",
      scoring_failed: "error",
      failed: "error",
      lost: "error",
      dismissed: "error",
      deprioritized: "error",
    }[status] || "info";
  return `<span class="gtss-status-badge ${statusClass}">${label}</span>`;
}

function renderScoreBadge(score) {
  const numericScore = Number(score) || 0;
  const scoreClass =
    numericScore >= 70 ? "success" : numericScore >= 40 ? "warning" : "error";
  return `<span class="gtss-score-badge ${scoreClass}">${numericScore}</span>`;
}

function renderStatCard(container, { label, value, delta, deltaLabel }) {
  const html = `
    <article class="gtss-stat-card gtss-card">
      <span>${label}</span>
      <strong>${value}</strong>
      ${delta !== undefined ? `<small>${delta} ${deltaLabel || ""}</small>` : ""}
    </article>
  `;
  if (container) {
    container.insertAdjacentHTML("beforeend", html);
  }
  return html;
}

function renderConfirmModal(message, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "gtss-confirm-overlay";
  overlay.innerHTML = `
    <div class="gtss-confirm-modal">
      <p>${message}</p>
      <div>
        <button class="gtss-confirm-cancel" type="button">Cancel</button>
        <button class="gtss-confirm-ok" type="button">Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay
    .querySelector(".gtss-confirm-cancel")
    .addEventListener("click", () => overlay.remove());
  overlay.querySelector(".gtss-confirm-ok").addEventListener("click", () => {
    overlay.remove();
    onConfirm();
  });
}

function renderEmptyState(container, message) {
  const html = `<div class="gtss-empty-state"><span>⌕</span><p>${message}</p></div>`;
  if (container) {
    container.innerHTML = html;
  }
  return html;
}

function renderDataTable(container, columns, rows, options = {}) {
  const pageSize = options.pageSize || 20;
  let currentPage = options.page || 1;
  let sortKey = null;
  let sortDir = 1;

  function valueFor(row, column) {
    return typeof column.render === "function"
      ? column.render(row)
      : row[column.key];
  }

  function draw() {
    let nextRows = [...rows];
    if (sortKey) {
      nextRows.sort(
        (a, b) =>
          String(a[sortKey] || "").localeCompare(String(b[sortKey] || "")) *
          sortDir,
      );
    }
    const totalPages = Math.max(Math.ceil(nextRows.length / pageSize), 1);
    const start = (currentPage - 1) * pageSize;
    const visibleRows = nextRows.slice(start, start + pageSize);

    container.innerHTML = `
      <div class="gtss-table-wrap">
        <table class="gtss-data-table">
          <thead><tr>${columns.map((column) => `<th data-sort="${column.key || ""}">${column.label}</th>`).join("")}</tr></thead>
          <tbody>${visibleRows.map((row) => `<tr>${columns.map((column) => `<td>${valueFor(row, column) || ""}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="gtss-table-pagination">
        <button data-page="prev" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
        <span>Page ${currentPage} of ${totalPages}</span>
        <button data-page="next" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    `;

    container.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (!key) return;
        sortDir = sortKey === key ? sortDir * -1 : 1;
        sortKey = key;
        draw();
      });
    });

    container
      .querySelector('[data-page="prev"]')
      .addEventListener("click", () => {
        currentPage = Math.max(currentPage - 1, 1);
        draw();
      });
    container
      .querySelector('[data-page="next"]')
      .addEventListener("click", () => {
        currentPage = Math.min(currentPage + 1, totalPages);
        draw();
      });
  }

  draw();
}

function escapeHtml(text) {
  if (typeof text !== "string") return String(text || "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", initShell);

const sharedApi = {
  fetchJSON,
  showToast,
  showConfirmDialog,
  initSSE,
  initSocket,
  getSocket,
  joinRoom,
  leaveRoom,
  loadPlatformCatalog,
  formatPlatformLabel,
  updateSessionDots,
  updateActionBadge,
  renderStatCard,
  renderPlatformBadge,
  renderStatusBadge,
  renderScoreBadge,
  renderConfirmModal,
  renderEmptyState,
  renderDataTable,
  escapeHtml,
};

window.gtss = sharedApi;
window.GTSS = sharedApi;

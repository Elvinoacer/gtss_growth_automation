async function fetchJSON(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  // Auto-set Content-Type for JSON bodies so callers don't have to
  if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  let data = null;
  const text = await response.text();
  if (text) {
    data = JSON.parse(text);
  }

  if (!response.ok) {
    const message =
      data && data.error ? data.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `gtss-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("visible"));
  window.setTimeout(() => {
    toast.classList.remove("visible");
    window.setTimeout(() => toast.remove(), 220);
  }, 4000);
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
        showToast('Connection lost. Attempting to reconnect...', 'warning');
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
  if (!_socket && typeof io !== 'undefined') {
    _socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });

    _socket.on('connect', () => {
      console.log('[GTSS] Socket.IO connected:', _socket.id);
    });

    _socket.on('disconnect', (reason) => {
      console.warn('[GTSS] Socket.IO disconnected:', reason);
    });

    _socket.on('connect_error', (err) => {
      console.warn('[GTSS] Socket.IO connection error:', err.message);
    });

    // Live updates for global UI elements
    _socket.on('stats:updated', () => {
      updateActionBadge();
    });

    _socket.on('sessions:updated', () => {
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
    console.warn('[GTSS] Socket.IO not available, falling back to polling');
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
  if (socket) socket.emit('subscribe', room);
}

function leaveRoom(room) {
  const socket = getSocket();
  if (socket) socket.emit('unsubscribe', room);
}

async function updateSessionDots() {
  try {
    const statuses = await fetchJSON("/api/sessions/status");
    Object.entries(statuses).forEach(([platform, isActive]) => {
      const dot = document.querySelector(`[data-platform-dot="${platform}"]`);
      if (dot) {
        dot.classList.toggle("active", Boolean(isActive));
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
    badge.classList.toggle("warning", ratio >= 0.7 && ratio < 0.9);
    badge.classList.toggle("danger", ratio >= 0.9);
  } catch (error) {
    badge.textContent = "Actions today: unavailable";
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

  document.querySelectorAll(".gtss-nav__link").forEach((link) => {
    const route = link.dataset.route;
    const active =
      route === "/"
        ? window.location.pathname === "/"
        : window.location.pathname.startsWith(route);
    link.classList.toggle("active", active);
  });

  if (toggle && sidebar) {
    toggle.addEventListener("click", () => {
      const collapsed = !sidebar.classList.contains("collapsed");
      sidebar.classList.toggle("collapsed", collapsed);
      document.body.classList.toggle("gtss-sidebar-collapsed", collapsed);
      localStorage.setItem("gtss.sidebar.collapsed", String(collapsed));
    });
  }

  if (notificationButton && notificationDropdown) {
    notificationButton.addEventListener("click", () => {
      notificationDropdown.classList.toggle("open");
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

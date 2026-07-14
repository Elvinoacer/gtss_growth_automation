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

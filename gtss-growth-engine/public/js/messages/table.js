/**
 * messages/table.js — Message table loader + renderer + pagination for the
 * Message Generator page.
 *
 * Exposes (via global scope):
 *   - loadMessages()      — async; queries /api/messages with the current
 *                           filter/platform/search/pagination state, caches
 *                           the result in `cachedMessages`, and re-renders
 *                           the table + pagination + total badge
 *   - renderTable(msgs)   — builds the <tr> rows for a list of messages
 *   - renderPagination()  — updates the page-label + prev/next disabled
 *                           state from `totalMessages` / `currentPage`
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, showToast, currentFilter, currentPlatform, currentSearch,
 *     currentPage, pageLimit, totalMessages, cachedMessages, msgBody,
 *     emptyState, totalBadge, prevPage, nextPage, pageLabel
 * Depends on (from messages/helpers.js, loaded earlier):
 *   - escapeHtml, truncate, relativeTime, platformClass, platformLabel
 */

async function loadMessages() {
  try {
    const params = new URLSearchParams({
      status: currentFilter,
      page: currentPage,
      limit: pageLimit,
    });
    if (currentPlatform) params.set("platform", currentPlatform);
    if (currentSearch) params.set("search", currentSearch);

    const data = await fetchJSON(`/api/messages?${params}`);
    totalMessages = data.total;
    cachedMessages = data.messages;
    renderTable(data.messages);
    renderPagination();
    totalBadge.textContent = `${data.total} messages`;
    // Keep Retry badge in sync with the Template / Template fallback
    // rows the operator can actually see (fixes count=0 / button-disabled
    // while the table still shows those badges).
    if (typeof updateRetryFallbacksButton === "function") {
      updateRetryFallbacksButton(null, null, { fromTable: true });
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderTable(messages) {
  if (!messages || messages.length === 0) {
    msgBody.innerHTML = "";
    emptyState.classList.add("visible");
    return;
  }

  emptyState.classList.remove("visible");

  msgBody.innerHTML = messages
    .map((msg) => {
      const preview = escapeHtml(truncate(msg.body, 60));
      const generated = relativeTime(msg.generated_at);
      const statusCls = `status-${msg.status || "pending"}`;
      const sourceBadge = sourceBadgeHtml(msg.generated_by);

      return `<tr data-msg-id="${msg.id}">
        <td>${escapeHtml(msg.lead_name || "—")}</td>
        <td><span class="platform-badge ${platformClass(msg.platform)}">${platformLabel(msg.platform)}</span></td>
        <td>${escapeHtml(msg.lead_company || "—")}</td>
        <td>
          <div class="msg-cell">
            <span class="msg-preview">${preview}</span>
            ${sourceBadge}
          </div>
        </td>
        <td><span class="variant-badge variant-${(msg.variant || "a").toLowerCase()}">${msg.variant || "—"}</span></td>
        <td><span class="status-pill ${statusCls}">${msg.status || "pending"}</span></td>
        <td style="color:var(--gtss-muted);">${generated}</td>
        <td>
          <div class="row-actions">
            ${
              msg.status === "pending"
                ? `
              <button class="btn btn-success btn-sm" data-action="approve-row" data-id="${msg.id}" title="Approve this ${msg.variant || "A"} variant">✓ Approve ${msg.variant || "A"}</button>
              <button class="btn btn-outline btn-sm" data-action="review" data-id="${msg.id}" title="Review & Approve">Review</button>
              <button class="btn btn-outline btn-sm" data-action="regenerate" data-id="${msg.id}" title="Regenerate">↺</button>
              <button class="btn btn-outline btn-sm" data-action="skip" data-id="${msg.id}" title="Skip">Skip</button>
            `
                : msg.status === "approved"
                  ? `
              <button class="btn btn-outline btn-sm" data-action="review" data-id="${msg.id}" title="View">View</button>
            `
                  : `
              <button class="btn btn-outline btn-sm" data-action="review" data-id="${msg.id}" title="View">View</button>
            `
            }
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(totalMessages / pageLimit));
  pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
  prevPage.disabled = currentPage <= 1;
  nextPage.disabled = currentPage >= totalPages;
}

/* ================================================================
   Message Generator – Frontend Logic
   ================================================================ */

(function () {
  "use strict";

  const { fetchJSON, showToast, getSocket } = window.gtss;

  // ---- State ----
  let currentFilter = "all";
  let currentPlatform = "";
  let currentSearch = "";
  let currentPage = 1;
  const pageLimit = 20;
  let totalMessages = 0;
  let cachedMessages = [];
  let activeSocketCleanup = null;
  let charLimits = {};
  let platformCatalog = [];
  let platformLabels = {};
  let defaultPlatform = "";
  let pipelineConfig = {};

  // Settings state
  let selectedTone = "friendly";
  let selectedProduct = "Restaurant Manager";

  // Modal state
  let modalLeadId = null;
  let modalVariantA = null; // { id, body }
  let modalVariantB = null;

  // ---- DOM refs ----
  const statPending = document.getElementById("stat-pending");
  const statApproved = document.getElementById("stat-approved");
  const statSent = document.getElementById("stat-sent");
  const statSkipped = document.getElementById("stat-skipped");
  const statFollowups = document.getElementById("stat-followups");
  const statUnscoredQualified = document.getElementById(
    "stat-unscored-qualified",
  );
  const unscoredQualifiedNote = document.getElementById(
    "unscored-qualified-note",
  );
  const tabPending = document.getElementById("tab-pending");
  const tabApprovedCount = document.getElementById("tab-approved");
  const tabSent = document.getElementById("tab-sent");
  const tabFollowups = document.getElementById("tab-followups");

  const generateAllBtn = document.getElementById("generate-all-btn");
  const progressPanel = document.getElementById("progress-panel");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const progressLabelText = document.getElementById("progress-label-text");

  const filterTabs = document.getElementById("filter-tabs");
  const platformFilter = document.getElementById("platform-filter");
  const searchInput = document.getElementById("search-input");
  const totalBadge = document.getElementById("total-badge");
  const msgBody = document.getElementById("msg-body");
  const emptyState = document.getElementById("empty-state");
  const prevPage = document.getElementById("prev-page");
  const nextPage = document.getElementById("next-page");
  const pageLabel = document.getElementById("page-label");

  // Modal refs
  const modalOverlay = document.getElementById("modal-overlay");
  const modalTitle = document.getElementById("modal-title");
  const modalSub = document.getElementById("modal-sub");
  const modalClose = document.getElementById("modal-close");
  const modalCloseBtn = document.getElementById("modal-close-btn");
  const ctxName = document.getElementById("ctx-name");
  const ctxRole = document.getElementById("ctx-role");
  const ctxCompany = document.getElementById("ctx-company");
  const ctxPlatform = document.getElementById("ctx-platform");
  const ctxScore = document.getElementById("ctx-score");
  const ctxReasoning = document.getElementById("ctx-reasoning");
  const ctxNotes = document.getElementById("ctx-notes");
  const variantATextarea = document.getElementById("variant-a-textarea");
  const variantBTextarea = document.getElementById("variant-b-textarea");
  const charCounterA = document.getElementById("char-counter-a");
  const charCounterB = document.getElementById("char-counter-b");
  const modalApproveA = document.getElementById("modal-approve-a");
  const modalApproveB = document.getElementById("modal-approve-b");
  const modalRegenerate = document.getElementById("modal-regenerate");
  const modalSkip = document.getElementById("modal-skip");
  const regenLoading = document.getElementById("regen-loading");

  // Settings refs
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const toneGroup = document.getElementById("tone-group");
  const productGroup = document.getElementById("product-group");
  const customPitchGroup = document.getElementById("custom-pitch-group");
  const customPitchInput = document.getElementById("custom-pitch-input");

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  function platformLabel(p) {
    return platformLabels[p] || window.gtss.formatPlatformLabel(p) || p || "—";
  }

  function platformClass(p) {
    return `platform-${(p || "").toLowerCase()}`;
  }

  function scoreColorClass(score) {
    if (score == null) return "";
    if (score < 40) return "score-red";
    if (score < 70) return "score-amber";
    return "score-green";
  }

  function truncate(text, len) {
    if (!text) return "—";
    return text.length > len ? text.slice(0, len) + "…" : text;
  }

  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = str || "";
    return el.innerHTML;
  }

  function relativeTime(dateStr) {
    if (!dateStr) return "—";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function getCharLimitForPlatform(platform) {
    if (platform === "x") return 500;
    // Determine the key based on platform
    const connectKey = `${platform}_connect`;
    const dmKey = `${platform}_dm`;
    return charLimits[connectKey] || charLimits[dmKey] || 1000;
  }

  async function loadPlatformFilterOptions() {
    platformCatalog = await window.gtss.loadPlatformCatalog();
    platformLabels = Object.fromEntries(
      platformCatalog.map((platform) => [platform.key, platform.label]),
    );
    defaultPlatform = platformCatalog[0]?.key || "";

    if (!platformFilter) {
      return;
    }

    const currentValue = platformFilter.value;
    platformFilter.innerHTML = [
      '<option value="">All Platforms</option>',
      ...platformCatalog.map(
        (platform) =>
          `<option value="${platform.key}">${escapeHtml(platform.label || window.gtss.formatPlatformLabel(platform.key))}</option>`,
      ),
    ].join("");

    if (currentValue) {
      platformFilter.value = currentValue;
    }
  }

  // ----------------------------------------------------------------
  // Stats
  // ----------------------------------------------------------------

  async function loadStats() {
    try {
      const stats = await fetchJSON("/api/messages/stats");
      statPending.textContent = stats.pending;
      statApproved.textContent = stats.approved;
      statSent.textContent = stats.sent;
      statSkipped.textContent = stats.skipped;
      statFollowups.textContent = stats.followUps;
      if (statUnscoredQualified) {
        statUnscoredQualified.textContent = stats.unscored_qualified || 0;
      }
      tabPending.textContent = stats.pending;
      tabApprovedCount.textContent = stats.approved;
      tabSent.textContent = stats.sent;
      tabFollowups.textContent = stats.followUps;

      if (stats.charLimits) charLimits = stats.charLimits;
      if (unscoredQualifiedNote) {
        unscoredQualifiedNote.textContent =
          stats.unscored_qualified > 0
            ? `${stats.unscored_qualified} qualified lead(s) still have no AI score and will be included in Generate All.`
            : "All qualified leads already have AI scores.";
      }
    } catch (err) {
      console.error("Failed to load stats", err);
    }
  }

  // ----------------------------------------------------------------
  // Message Table
  // ----------------------------------------------------------------

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

        return `<tr data-msg-id="${msg.id}">
        <td>${escapeHtml(msg.lead_name || "—")}</td>
        <td><span class="platform-badge ${platformClass(msg.platform)}">${platformLabel(msg.platform)}</span></td>
        <td>${escapeHtml(msg.lead_company || "—")}</td>
        <td><span class="msg-preview">${preview}</span></td>
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

  // ----------------------------------------------------------------
  // Generate All (batch)
  // ----------------------------------------------------------------

  async function generateAll() {
    generateAllBtn.disabled = true;
    progressPanel.classList.add("visible");
    progressFill.style.width = "0%";
    progressText.textContent = "Starting...";
    progressLabelText.textContent = "Generating messages with Gemini AI...";

    try {
      const { jobId, pendingCount } = await fetchJSON(
        "/api/messages/generate-all",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productPitch: selectedProduct,
            tone: selectedTone,
          }),
        },
      );

      if (!jobId) {
        showToast("No qualified leads without messages", "info");
        progressPanel.classList.remove("visible");
        generateAllBtn.disabled = false;
        return;
      }

      // Legacy SSE to trigger backend stream
      const legacySSE = window.gtss.initSSE(`/api/messages/stream/${jobId}`, () => {});

      const socket = getSocket();
      if (!socket) return;

      function onMsgEvent(event) {
        if (!event) return;
        if (event.jobId && String(event.jobId) !== String(jobId)) return;

        if (event.type === "progress") {
          const pct =
            event.total > 0
              ? Math.round((event.processed / event.total) * 100)
              : 0;
          progressFill.style.width = `${pct}%`;
          progressText.textContent = `${event.processed} / ${event.total} messages generated`;
        }

        if (event.type === "generated") {
          loadMessages();
        }

        if (event.type === "done") {
          progressFill.style.width = "100%";
          progressLabelText.textContent = "Generation complete!";
          progressText.textContent = `${event.result.succeeded} generated, ${event.result.failed} failed`;
          showToast(
            `Generated messages for ${event.result.succeeded} leads`,
            "success",
          );

          cleanup();
          generateAllBtn.disabled = false;
          loadStats();
          loadMessages();

          setTimeout(() => {
            progressPanel.classList.remove("visible");
          }, 5000);
        }

        if (event.type === "error") {
          showToast(`Error: ${event.message}`, "error");
        }
      }

      function cleanup() {
        socket.off('messages:event', onMsgEvent);
        if (legacySSE) legacySSE.close();
        activeSocketCleanup = null;
      }

      activeSocketCleanup = cleanup;
      socket.on('messages:event', onMsgEvent);
    } catch (err) {
      showToast(err.message, "error");
      progressPanel.classList.remove("visible");
      generateAllBtn.disabled = false;
    }
  }

  // ----------------------------------------------------------------
  // Modal: Review & Approve
  // ----------------------------------------------------------------

  function openModal(msg) {
    modalLeadId = msg.lead_id;
    modalTitle.textContent = `Review Message: ${msg.lead_name || "Unknown"}`;
    modalSub.textContent = `${platformLabel(msg.platform)} · Variant ${msg.variant || "A/B"}`;

    // Context
    ctxName.textContent = msg.lead_name || "—";
    ctxRole.textContent = msg.lead_role || "—";
    ctxCompany.textContent = msg.lead_company || "—";
    ctxPlatform.innerHTML = `<span class="platform-badge ${platformClass(msg.lead_platform || msg.platform)}">${platformLabel(msg.lead_platform || msg.platform)}</span>`;

    if (msg.lead_score != null) {
      ctxScore.innerHTML = `<span class="score-badge ${scoreColorClass(msg.lead_score)}">${msg.lead_score}</span>`;
    } else {
      ctxScore.textContent = "—";
    }

    ctxReasoning.textContent = msg.score_reason || "No AI reasoning available.";
    ctxNotes.textContent = msg.lead_notes || "No notes.";

    // Find both variants for this lead
    const allForLead = cachedMessages.filter(
      (m) => m.lead_id === msg.lead_id && m.is_follow_up === 0,
    );
    const varA =
      allForLead.find((m) => m.variant === "A") ||
      (msg.variant === "A" ? msg : null);
    const varB =
      allForLead.find((m) => m.variant === "B") ||
      (msg.variant === "B" ? msg : null);

    modalVariantA = varA ? { id: varA.id, body: varA.body } : null;
    modalVariantB = varB ? { id: varB.id, body: varB.body } : null;

    variantATextarea.value = modalVariantA ? modalVariantA.body : "";
    variantBTextarea.value = modalVariantB ? modalVariantB.body : "";

    const platformHintEl = document.getElementById("modal-platform-hint");
    if (platformHintEl) {
      const platform = (msg.platform || "").toLowerCase();
      if (platform === "x") {
        const outreachMode = pipelineConfig.xOutreachMode || "follow_first";
        let modeLabel = "";
        if (outreachMode === "follow_first") {
          modeLabel = "<strong>Follow First</strong>: The system will first follow the lead to warm up, then send this direct message.";
        } else if (outreachMode === "dm_only") {
          modeLabel = "<strong>Direct Message Only</strong>: The system will directly send this message without following.";
        } else {
          modeLabel = "<strong>Direct Message First</strong>: The system will send the DM first, and follow only if direct messaging succeeds/needs fallback.";
        }
        platformHintEl.innerHTML = `💡 <strong>X Platform Hint</strong>: Direct messages are capped at 500 characters.<br>${modeLabel}`;
        platformHintEl.style.display = "block";
      } else if (platform === "linkedin") {
        const outreachMode = pipelineConfig.linkedinOutreachMode || "connect_first";
        let modeLabel = "";
        if (outreachMode === "connect_first") {
          modeLabel = "<strong>Connect First</strong>: The message will be sent as a personalized connection request (max 300 characters). If already connected, it will be a direct message (max 1000 characters).";
        } else {
          modeLabel = "<strong>Direct Message Only</strong>: The message will be sent directly as a direct message (max 1000 characters).";
        }
        platformHintEl.innerHTML = `💡 <strong>LinkedIn Platform Hint</strong>: Connection messages are capped at 300 characters, while DMs are capped at 1000 characters.<br>${modeLabel}`;
        platformHintEl.style.display = "block";
      } else {
        platformHintEl.innerHTML = `💡 <strong>${platformLabel(platform)} Hint</strong>: Direct message will be sent directly to the lead. Max limit is 1000 characters.`;
        platformHintEl.style.display = "block";
      }
    }

    const limit = getCharLimitForPlatform(msg.platform);
    updateCharCounter(variantATextarea, charCounterA, limit);
    updateCharCounter(variantBTextarea, charCounterB, limit);

    // Show/hide approve buttons based on status
    const isPending = msg.status === "pending";
    modalApproveA.style.display = isPending && modalVariantA ? "" : "none";
    modalApproveB.style.display = isPending && modalVariantB ? "" : "none";
    modalRegenerate.style.display = isPending ? "" : "none";
    modalSkip.style.display = isPending ? "" : "none";

    variantATextarea.readOnly = !isPending;
    variantBTextarea.readOnly = !isPending;

    regenLoading.classList.remove("visible");
    modalOverlay.classList.add("open");
  }

  function closeModal() {
    modalOverlay.classList.remove("open");
    modalLeadId = null;
    modalVariantA = null;
    modalVariantB = null;

    const platformHintEl = document.getElementById("modal-platform-hint");
    if (platformHintEl) {
      platformHintEl.style.display = "none";
      platformHintEl.innerHTML = "";
    }
  }

  function updateCharCounter(textarea, counterEl, limit) {
    const len = textarea.value.length;
    counterEl.textContent = `${len} / ${limit}`;
    counterEl.className =
      "char-counter " +
      (len > limit ? "char-over" : len > limit * 0.9 ? "char-warn" : "char-ok");
  }

  // ----------------------------------------------------------------
  // Actions
  // ----------------------------------------------------------------

  async function approveVariant(variant) {
    const data = variant === "A" ? modalVariantA : modalVariantB;
    if (!data) return;

    const body =
      variant === "A" ? variantATextarea.value : variantBTextarea.value;

    try {
      await fetchJSON(`/api/messages/${data.id}/approve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      showToast(`Variant ${variant} approved!`, "success");
      closeModal();
      loadStats();
      loadMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function skipMessage(id) {
    try {
      await fetchJSON(`/api/messages/${id}/skip`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      showToast("Lead skipped", "info");
      closeModal();
      loadStats();
      loadMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /**
   * Approve a single pending message directly from its row (without opening
   * the review modal). The sibling variant for the same lead is automatically
   * skipped by the backend.
   */
  async function approveRowMessage(id) {
    const msg = cachedMessages.find((m) => m.id === id);
    if (!msg) return;
    try {
      await fetchJSON(`/api/messages/${id}/approve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: msg.body }),
      });
      showToast(`Variant ${msg.variant || "A"} approved!`, "success");
      loadStats();
      loadMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /**
   * Bulk-approve all pending messages of a given variant ("A" or "B").
   * Calls POST /api/messages/bulk-approve.
   */
  async function bulkApprove(variant) {
    try {
      const result = await fetchJSON("/api/messages/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant }),
      });
      showToast(result.message, result.approved > 0 ? "success" : "info", 6000);
      loadStats();
      loadMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function regenerateVariants(id) {
    regenLoading.classList.add("visible");
    modalRegenerate.disabled = true;

    try {
      const result = await fetchJSON(`/api/messages/${id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productPitch: selectedProduct,
          tone: selectedTone,
        }),
      });

      modalVariantA = result.variantA;
      modalVariantB = result.variantB;
      variantATextarea.value = result.variantA.body;
      variantBTextarea.value = result.variantB ? result.variantB.body : "";

      // Update approve button visibility
      modalApproveA.style.display = result.variantA ? "" : "none";
      modalApproveB.style.display = result.variantB ? "" : "none";

      // Update char counters
      const platform =
        cachedMessages.find((m) => m.lead_id === modalLeadId)?.platform ||
        defaultPlatform;
      const limit = getCharLimitForPlatform(platform);
      updateCharCounter(variantATextarea, charCounterA, limit);
      updateCharCounter(variantBTextarea, charCounterB, limit);

      showToast("Variants regenerated", "success");
      loadMessages();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      regenLoading.classList.remove("visible");
      modalRegenerate.disabled = false;
    }
  }

  // ----------------------------------------------------------------
  // Event Listeners
  // ----------------------------------------------------------------

  // Filter tabs
  filterTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".filter-tab");
    if (!tab) return;
    filterTabs
      .querySelectorAll(".filter-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.status;
    currentPage = 1;
    loadMessages();
  });

  // Platform filter
  platformFilter.addEventListener("change", () => {
    currentPlatform = platformFilter.value;
    currentPage = 1;
    loadMessages();
  });

  // Search
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = searchInput.value.trim();
      currentPage = 1;
      loadMessages();
    }, 350);
  });

  // Generate all
  generateAllBtn.addEventListener("click", generateAll);

  // Approve All A / Approve All B bulk buttons
  const approveAllABtn = document.getElementById("approve-all-a-btn");
  const approveAllBBtn = document.getElementById("approve-all-b-btn");
  if (approveAllABtn) {
    approveAllABtn.addEventListener("click", () => bulkApprove("A"));
  }
  if (approveAllBBtn) {
    approveAllBBtn.addEventListener("click", () => bulkApprove("B"));
  }

  // Pagination
  prevPage.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadMessages();
    }
  });
  nextPage.addEventListener("click", () => {
    const totalPages = Math.ceil(totalMessages / pageLimit);
    if (currentPage < totalPages) {
      currentPage++;
      loadMessages();
    }
  });

  // Table row actions (delegation)
  msgBody.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const id = Number(actionBtn.dataset.id);
      const action = actionBtn.dataset.action;

      if (action === "review") {
        const msg = cachedMessages.find((m) => m.id === id);
        if (msg) openModal(msg);
      } else if (action === "regenerate") {
        regenerateVariants(id);
      } else if (action === "skip") {
        skipMessage(id);
      } else if (action === "approve-row") {
        approveRowMessage(id);
      }
      return;
    }

    // Row click → open modal
    const row = e.target.closest("tr[data-msg-id]");
    if (row) {
      const id = Number(row.dataset.msgId);
      const msg = cachedMessages.find((m) => m.id === id);
      if (msg) openModal(msg);
    }
  });

  // Modal events
  modalClose.addEventListener("click", closeModal);
  modalCloseBtn.addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  modalApproveA.addEventListener("click", () => approveVariant("A"));
  modalApproveB.addEventListener("click", () => approveVariant("B"));

  modalRegenerate.addEventListener("click", () => {
    const id = modalVariantA
      ? modalVariantA.id
      : modalVariantB
        ? modalVariantB.id
        : null;
    if (id) regenerateVariants(id);
  });

  modalSkip.addEventListener("click", () => {
    const id = modalVariantA
      ? modalVariantA.id
      : modalVariantB
        ? modalVariantB.id
        : null;
    if (id) skipMessage(id);
  });

  // Char counter updates
  variantATextarea.addEventListener("input", () => {
    const msg = cachedMessages.find((m) => m.lead_id === modalLeadId);
    const limit = getCharLimitForPlatform(msg?.platform || defaultPlatform);
    updateCharCounter(variantATextarea, charCounterA, limit);
  });

  variantBTextarea.addEventListener("input", () => {
    const msg = cachedMessages.find((m) => m.lead_id === modalLeadId);
    const limit = getCharLimitForPlatform(msg?.platform || defaultPlatform);
    updateCharCounter(variantBTextarea, charCounterB, limit);
  });

  // Settings sidebar
  settingsToggle.addEventListener("click", () => {
    settingsPanel.classList.toggle("open");
  });

  // Tone selector
  toneGroup.addEventListener("click", (e) => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    toneGroup
      .querySelectorAll(".radio-pill")
      .forEach((p) => p.classList.remove("selected"));
    pill.classList.add("selected");
    selectedTone = pill.dataset.value;
  });

  // Message source selector (AI vs Template)
  const messageSourceGroup = document.getElementById("message-source-group");
  if (messageSourceGroup) {
    // Load the persisted preference on init.
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings) => {
        const stored = settings.message_generation_source || "ai";
        messageSourceGroup
          .querySelectorAll(".radio-pill")
          .forEach((p) => p.classList.remove("selected"));
        const match = messageSourceGroup.querySelector(
          `.radio-pill[data-value="${stored}"]`,
        );
        if (match) match.classList.add("selected");
      })
      .catch(() => {});

    messageSourceGroup.addEventListener("click", (e) => {
      const pill = e.target.closest(".radio-pill");
      if (!pill) return;
      messageSourceGroup
        .querySelectorAll(".radio-pill")
        .forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
      const value = pill.dataset.value; // 'ai' | 'template'
      // Persist to settings so the backend messageService picks it up.
      fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_generation_source: value }),
      })
        .then(() => {
          showToast(
            value === "ai"
              ? "AI message generation enabled. New drafts will use Gemini."
              : "Template mode enabled. New drafts will use your saved templates.",
            "info",
          );
        })
        .catch((err) => showToast(err.message, "error"));
    });
  }

  // Product selector
  productGroup.addEventListener("click", (e) => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    productGroup
      .querySelectorAll(".radio-pill")
      .forEach((p) => p.classList.remove("selected"));
    pill.classList.add("selected");

    if (pill.dataset.value === "custom") {
      customPitchGroup.style.display = "";
      selectedProduct = customPitchInput.value || "Restaurant Manager";
    } else {
      customPitchGroup.style.display = "none";
      selectedProduct = pill.dataset.value;
    }
  });

  customPitchInput.addEventListener("input", () => {
    selectedProduct = customPitchInput.value || "Restaurant Manager";
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay.classList.contains("open")) {
      closeModal();
    }
  });

  async function loadPipelineConfig() {
    try {
      pipelineConfig = await fetchJSON("/api/settings/pipeline");
    } catch (err) {
      console.warn("Failed to load pipeline config for outreach hints:", err);
    }
  }

  // ----------------------------------------------------------------
  // Init
  // ----------------------------------------------------------------

  loadPlatformFilterOptions().finally(() => {
    loadPipelineConfig().finally(() => {
      loadStats();
      loadMessages();
    });
  });
})();

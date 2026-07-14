/**
 * messages/events.js — All top-level event listeners for the Message
 * Generator page. Runs at script-load time (the original IIFE body did
 * the same — these `addEventListener` calls happened during the initial
 * parse-and-execute pass).
 *
 * Wires:
 *   - Filter tabs (all / pending / approved / sent / followups)
 *   - Platform-filter <select>
 *   - Search input (debounced 350ms)
 *   - Generate All button (→ generateAll)
 *   - Approve-all-A / Approve-all-B bulk buttons (→ bulkApprove)
 *   - Pagination prev/next buttons
 *   - Table row action delegation (review / regenerate / skip / approve-row,
 *     plus row click → openModal)
 *   - Modal close (X / Close button / backdrop click)
 *   - Modal Approve A / Approve B / Regenerate / Skip buttons
 *   - Variant-A/B textarea input → char-counter update
 *   - Settings sidebar toggle
 *   - Tone selector (radio-pill group)
 *   - Message-source selector (AI vs Template) — persists to /api/settings
 *   - Product selector (radio-pill group) + custom-pitch input
 *   - Escape keyboard shortcut to close the modal
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - filterTabs, platformFilter, searchInput, generateAllBtn, prevPage,
 *     nextPage, msgBody, modalOverlay, modalClose, modalCloseBtn,
 *     modalApproveA, modalApproveB, modalRegenerate, modalSkip,
 *     variantATextarea, variantBTextarea, charCounterA, charCounterB,
 *     settingsToggle, settingsPanel, toneGroup, productGroup,
 *     customPitchGroup, customPitchInput, modalVariantA, modalVariantB,
 *     modalLeadId, defaultPlatform, cachedMessages, currentPage,
 *     totalMessages, pageLimit, currentFilter, currentPlatform,
 *     currentSearch, selectedTone, selectedProduct
 * Depends on (from messages/table.js, loaded earlier):
 *   - loadMessages
 * Depends on (from messages/generateAll.js, loaded earlier):
 *   - generateAll
 * Depends on (from messages/modal.js, loaded earlier):
 *   - openModal, closeModal, updateCharCounter
 * Depends on (from messages/actions.js, loaded earlier):
 *   - approveVariant, skipMessage, approveRowMessage, bulkApprove,
 *     regenerateVariants
 * Depends on (from messages/helpers.js, loaded earlier):
 *   - getCharLimitForPlatform
 * Depends on (from window.gtss, set up in state.js):
 *   - showToast
 */

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

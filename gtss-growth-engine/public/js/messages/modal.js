/**
 * messages/modal.js — Review-and-approve modal for the Message Generator
 * page.
 *
 * Owns the modal that pops up when the user clicks "Review" or a row. It
 * shows lead context, displays both A/B variants in editable textareas
 * with per-platform character counters, and conditionally reveals
 * platform-specific outreach hints (X follow-first vs DM-only, LinkedIn
 * connect-first vs DM-only) sourced from `pipelineConfig`.
 *
 * Exposes (via global scope):
 *   - openModal(msg)                — populate and open the review modal for
 *                                      a single message row
 *   - closeModal()                  — hide the modal and clear modal state
 *   - updateCharCounter(textarea,
 *       counterEl, limit)           — shared character-counter renderer used
 *                                      by both variant inputs (and by
 *                                      actions.js after a regenerate)
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - modalOverlay, modalTitle, modalSub, ctxName, ctxRole, ctxCompany,
 *     ctxPlatform, ctxScore, ctxReasoning, ctxNotes, variantATextarea,
 *     variantBTextarea, charCounterA, charCounterB, modalApproveA,
 *     modalApproveB, modalRegenerate, modalSkip, regenLoading, modalLeadId,
 *     modalVariantA, modalVariantB, cachedMessages, pipelineConfig
 * Depends on (from messages/helpers.js, loaded earlier):
 *   - platformLabel, platformClass, scoreColorClass, getCharLimitForPlatform
 */

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

/**
 * messages/actions.js — Per-row + bulk action calls for the Message
 * Generator page (approve / skip / regenerate variants).
 *
 * Exposes (via global scope):
 *   - approveVariant(variant)         — PATCH the current modal's chosen
 *                                       variant ("A"|"B") body to
 *                                       /api/messages/:id/approve, then
 *                                       close the modal + reload stats +
 *                                       refresh the table
 *   - skipMessage(id)                 — PATCH /api/messages/:id/skip
 *   - approveRowMessage(id)           — approve a single pending message
 *                                       directly from its row without
 *                                       opening the modal; the sibling
 *                                       variant for the same lead is
 *                                       automatically skipped by the
 *                                       backend
 *   - bulkApprove(variant)            — POST /api/messages/bulk-approve
 *                                       with {variant:"A"|"B"}
 *   - regenerateVariants(id)          — POST /api/messages/:id/regenerate
 *                                       with the current tone + product;
 *                                       swaps in the new A/B bodies and
 *                                       updates char counters
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, showToast, modalVariantA, modalVariantB, variantATextarea,
 *     variantBTextarea, charCounterA, charCounterB, modalApproveA,
 *     modalApproveB, modalRegenerate, regenLoading, modalLeadId,
 *     cachedMessages, defaultPlatform, selectedTone, selectedProduct
 * Depends on (from messages/modal.js, loaded earlier):
 *   - closeModal, updateCharCounter
 * Depends on (from messages/helpers.js, loaded earlier):
 *   - getCharLimitForPlatform
 * Depends on (from messages/table.js, loaded earlier):
 *   - loadMessages
 * Depends on (from messages/stats.js, loaded earlier):
 *   - loadStats
 */

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

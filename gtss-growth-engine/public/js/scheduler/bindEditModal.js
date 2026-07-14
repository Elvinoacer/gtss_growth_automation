/* global gtss */
/**
 * scheduler/bindEditModal.js — Event bindings for the Edit Post modal
 * (close, backdrop-click, save, delete, publish-now).
 *
 * Defines `bindEditModal()` — called from bindEvents() in init.js. Each
 * `addEventListener` is moved verbatim from the original scheduler.js
 * `bindEvents` function (lines 1212-1311). The modal loaders
 * (openEditModal, closeEditModal) live in editModal.js.
 *
 * Bindings:
 *   - edit-modal-close   "click"  → closeEditModal()
 *   - edit-modal-backdrop "click" → closeEditModal() if click was on the
 *                                    backdrop itself (not a child)
 *   - edit-save-btn      "click"  → validate IG-media rule, then PATCH
 *                                    /api/scheduler/posts/:id with new
 *                                    platforms/body/scheduledAt
 *   - edit-delete-btn    "click"  → confirm via window.gtss.confirm, then
 *                                    DELETE /api/scheduler/posts/:id
 *   - edit-publish-btn   "click"  → validate IG-media rule, then POST
 *                                    /api/scheduler/posts/:id/publish-now
 *                                    and startPublishStream
 */

function bindEditModal() {
  // Edit Modal
  $("edit-modal-close").addEventListener("click", closeEditModal);
  $("edit-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === $("edit-modal-backdrop")) closeEditModal();
  });

  $("edit-save-btn").addEventListener("click", async () => {
    if (!editingPostId) return;
    const platforms = [
      ...document.querySelectorAll(".edit-platform-cb:checked"),
    ].map((cb) => cb.value);
    const body = $("edit-body").value;
    const scheduledAt = new Date(
      `${$("edit-date").value}T${$("edit-time").value}`,
    ).toISOString();

    const hasInstagram = platforms.includes("instagram");
    const hasMedia =
      editingPostMedia && String(editingPostMedia).trim() !== "";

    if (hasMedia && !hasInstagram) {
      return showToast(
        "Media attachments are only allowed when Instagram is selected as a target platform.",
        "error",
      );
    }
    if (hasInstagram && !hasMedia) {
      return showToast(
        "Instagram posts require a media attachment (image or video).",
        "error",
      );
    }

    try {
      await fetchJSON(`/api/scheduler/posts/${editingPostId}`, {
        method: "PATCH",
        body: JSON.stringify({ platforms, body, scheduledAt }),
      });
      showToast("Post updated", "success");
      closeEditModal();
      loadCalendar();
      loadQueue();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("edit-delete-btn").addEventListener("click", async () => {
    if (!editingPostId) return;
    const confirmed = window.gtss?.confirm
      ? await window.gtss.confirm("Delete this post? This cannot be undone.")
      : confirm("Delete this post? This cannot be undone.");
    if (!confirmed) return;
    try {
      await fetchJSON(`/api/scheduler/posts/${editingPostId}`, {
        method: "DELETE",
      });
      showToast("Post deleted", "success");
      closeEditModal();
      loadCalendar();
      loadQueue();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("edit-publish-btn").addEventListener("click", async () => {
    if (!editingPostId) return;

    const platforms = [
      ...document.querySelectorAll(".edit-platform-cb:checked"),
    ].map((cb) => cb.value);
    const hasInstagram = platforms.includes("instagram");
    const hasMedia =
      editingPostMedia && String(editingPostMedia).trim() !== "";

    if (hasMedia && !hasInstagram) {
      return showToast(
        "Media attachments are only allowed when Instagram is selected as a target platform.",
        "error",
      );
    }
    if (hasInstagram && !hasMedia) {
      return showToast(
        "Instagram posts require a media attachment (image or video).",
        "error",
      );
    }

    try {
      const data = await fetchJSON(
        `/api/scheduler/posts/${editingPostId}/publish-now`,
        { method: "POST" },
      );
      closeEditModal();
      startPublishStream(data.jobId);
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

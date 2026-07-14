/* global gtss */
/**
 * scheduler/editModal.js — Edit-post modal loader + closer.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 609-641). The modal bindings (close button, save, delete,
 * publish-now) live in bindEditModal.js.
 *
 * openEditModal fetches the full post list from /api/scheduler/posts and
 * picks the one matching postId — there is no single-post endpoint. It then
 * populates the edit-modal form (platform checkboxes, body, date, time).
 */

// ── Edit Modal ──

async function openEditModal(postId) {
  editingPostId = postId;
  let post;
  try {
    const posts = await fetchJSON(`/api/scheduler/posts`);
    post = posts.find((p) => p.id == postId);
  } catch {
    return showToast("Failed to load post", "error");
  }
  if (!post) return;
  editingPostMedia = post.media_path;

  const platforms = Array.isArray(post.platforms)
    ? post.platforms
    : JSON.parse(post.platforms || "[]");
  document.querySelectorAll(".edit-platform-cb").forEach((cb) => {
    cb.checked = platforms.includes(cb.value);
  });
  $("edit-body").value = post.body || "";
  if (post.scheduled_at) {
    const d = new Date(post.scheduled_at);
    $("edit-date").value = formatLocalDateInput(d);
    $("edit-time").value = d.toTimeString().slice(0, 5);
  }
  $("edit-modal-backdrop").classList.remove("hidden");
}

function closeEditModal() {
  $("edit-modal-backdrop").classList.add("hidden");
  editingPostId = null;
}

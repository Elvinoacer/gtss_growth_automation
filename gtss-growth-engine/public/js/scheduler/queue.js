/* global gtss */
/**
 * scheduler/queue.js — Up-next queue list + published-post log renderers
 * for the Content Scheduler page.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 459-577). Both renderers fetch from /api/scheduler/posts filtered
 * by status:
 *   - loadQueue: status=scheduled, sorted soonest-first, top 5 shown in the
 *     "Up Next" sidebar.
 *   - loadPublishedLog: status=published, rendered as a table with inline
 *     likes / comments / reach inputs and a Save button per row that PATCHes
 *     /api/scheduler/posts/:id/stats.
 */

// ── Queue ──

async function loadQueue() {
  let posts = [];
  try {
    posts = await fetchJSON("/api/scheduler/posts?status=scheduled");
  } catch {
    /* empty */
  }

  // Sort by soonest and take 5
  posts.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const upcoming = posts.slice(0, 5);

  queueCountBadge.textContent = `${posts.length} Total`;
  queueList.innerHTML = "";

  if (upcoming.length === 0) {
    queueList.innerHTML =
      '<p class="text-body-xs text-on-surface-variant text-center py-4">No upcoming posts</p>';
    return;
  }

  upcoming.forEach((post) => {
    const pDate = new Date(post.scheduled_at);
    const timeStr =
      pDate.toLocaleDateString([], { month: "short", day: "numeric" }) +
      ", " +
      pDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const platforms = Array.isArray(post.platforms)
      ? post.platforms
      : JSON.parse(post.platforms || "[]");
    const dots = platforms
      .map(
        (p) =>
          `<div class="w-3 h-3 rounded-full" style="background:${PLATFORM_COLORS[p] || "#999"}"></div>`,
      )
      .join("");
    const preview = (post.body || "").slice(0, 50);

    const div = document.createElement("div");
    div.className =
      "bg-surface border border-outline-variant rounded p-2.5 text-body-xs flex gap-2.5 items-start cursor-pointer hover:border-outline transition-colors";
    div.innerHTML = `
      <div class="w-8 h-8 rounded bg-surface-variant flex-shrink-0 flex flex-wrap gap-0.5 p-1 items-center justify-center">${dots}</div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-on-surface text-[11px] mb-0.5">${timeStr}</div>
        <p class="text-on-surface-variant line-clamp-2 text-[11px]">${preview}</p>
      </div>`;
    div.addEventListener("click", () => openEditModal(post.id));
    queueList.appendChild(div);
  });
}

// ── Published Log ──

async function loadPublishedLog() {
  let posts = [];
  try {
    posts = await fetchJSON("/api/scheduler/posts?status=published");
  } catch {
    /* empty */
  }

  publishedBody.innerHTML = "";
  if (posts.length === 0) {
    publishedBody.innerHTML =
      '<tr><td colspan="7" class="px-4 py-8 text-center text-on-surface-variant">No published posts yet.</td></tr>';
    return;
  }

  posts.forEach((post) => {
    const platforms = Array.isArray(post.platforms)
      ? post.platforms
      : JSON.parse(post.platforms || "[]");
    const platformLabels = platforms
      .map((p) => `<span class="capitalize">${p}</span>`)
      .join(", ");
    const preview = (post.body || "").slice(0, 60);
    const pubDate = post.published_at
      ? new Date(post.published_at).toLocaleString()
      : "-";

    const tr = document.createElement("tr");
    tr.className = "hover:bg-surface-container-low transition-colors";
    tr.innerHTML = `
      <td class="px-4 py-3 text-body-sm">${platformLabels}</td>
      <td class="px-4 py-3 text-body-sm text-on-surface-variant max-w-[200px] truncate">${preview}</td>
      <td class="px-4 py-3 text-body-xs text-on-surface-variant">${pubDate}</td>
      <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.likes || 0}" data-post-id="${post.id}" data-field="likes"/></td>
      <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.comments || 0}" data-post-id="${post.id}" data-field="comments"/></td>
      <td class="px-4 py-3"><input type="number" class="w-16 border border-outline-variant rounded px-2 py-1 text-body-xs text-center" value="${post.reach || 0}" data-post-id="${post.id}" data-field="reach"/></td>
      <td class="px-4 py-3"><button class="text-primary text-body-xs hover:underline save-stats-btn" data-post-id="${post.id}">Save</button></td>`;
    publishedBody.appendChild(tr);
  });

  // Bind save stats buttons
  publishedBody.querySelectorAll(".save-stats-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.postId;
      const row = btn.closest("tr");
      const likes =
        parseInt(row.querySelector('[data-field="likes"]').value) || 0;
      const comments =
        parseInt(row.querySelector('[data-field="comments"]').value) || 0;
      const reach =
        parseInt(row.querySelector('[data-field="reach"]').value) || 0;
      try {
        await fetchJSON(`/api/scheduler/posts/${pid}/stats`, {
          method: "PATCH",
          body: JSON.stringify({ likes, comments, reach }),
        });
        showToast("Stats saved", "success");
      } catch (e) {
        showToast(e.message, "error");
      }
    });
  });
}

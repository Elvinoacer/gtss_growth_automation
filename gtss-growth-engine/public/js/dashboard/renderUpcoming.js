/**
 * dashboard/renderUpcoming.js — Upcoming-scheduled-posts feed.
 *
 * renderUpcoming(posts) — renders one card per upcoming scheduler post
 * with platform-color dots (one per target platform), the scheduled
 * time (localized short-date + hour:minute), the post body preview
 * (line-clamped to 2 lines), and an "Edit →" link to /scheduler.
 * Empty-state message when there are no upcoming posts.
 *
 * Cross-file dependencies: $ (state.js), PLATFORM_COLORS (state.js).
 */

// ── Upcoming Posts ──
function renderUpcoming(posts) {
  const container = $("upcoming-posts");
  container.innerHTML = "";
  if (!posts || posts.length === 0) {
    container.innerHTML =
      '<p class="py-6 text-center text-sm text-slate-300">No upcoming posts</p>';
    return;
  }
  posts.forEach((p) => {
    const platforms = Array.isArray(p.platforms) ? p.platforms : [];
    const dots = platforms
      .map(
        (pl) =>
          `<div class="w-2.5 h-2.5 rounded-full" style="background:${PLATFORM_COLORS[pl] || "#999"}"></div>`,
      )
      .join("");
    const time = new Date(p.scheduledAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const div = document.createElement("div");
    div.className =
      "rounded-2xl border border-white/10 bg-slate-950/50 p-4 text-sm transition-colors hover:border-sky-300/30";
    div.innerHTML = `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="flex gap-1">${dots}</div>
          <span class="ml-auto text-slate-400">${time}</span>
        </div>
        <p class="line-clamp-2 text-slate-100">${p.bodyPreview}</p>
        <a href="/scheduler" class="mt-2 inline-block text-sm font-semibold text-sky-300 hover:text-sky-200">Edit →</a>`;
    container.appendChild(div);
  });
}

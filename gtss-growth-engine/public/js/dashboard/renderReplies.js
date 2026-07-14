/**
 * dashboard/renderReplies.js — Recent-replies feed + time-ago helper.
 *
 * renderReplies(replies) — renders one card per recent reply with a
 * platform-color dot, lead name + company, time-ago stamp, the message
 * snippet (truncated to 80 chars), and a "Review →" link to the CRM
 * detail view for that lead. Empty-state message when there are no
 * replies yet.
 *
 * getTimeAgo(dateStr) — relative-time formatter used by renderReplies
 * AND renderSessions (e.g. "just now", "5m ago", "3h ago", "2d ago").
 * Lives here because renderReplies is its primary consumer; renderSessions
 * (renderSessions.js) references it by bare name at call time.
 *
 * Cross-file dependencies: $ (state.js), PLATFORM_COLORS (state.js),
 * getTimeAgo (same file).
 */

// ── Recent Replies ──
function renderReplies(replies) {
  const feed = $("replies-feed");
  feed.innerHTML = "";
  if (!replies || replies.length === 0) {
    feed.innerHTML =
      '<p class="py-6 text-center text-sm text-slate-300">No replies yet</p>';
    return;
  }
  replies.forEach((r) => {
    const timeAgo = getTimeAgo(r.repliedAt);
    const color = PLATFORM_COLORS[r.platform] || "#999";
    const div = document.createElement("div");
    div.className =
      "rounded-2xl border border-white/10 bg-slate-950/50 p-4 text-sm transition-colors hover:border-sky-300/30";
    div.innerHTML = `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></div>
          <span class="font-semibold text-slate-100">${r.name || "Unknown"}</span>
          ${r.company ? `<span class="text-slate-300">· ${r.company}</span>` : ""}
          <span class="ml-auto text-slate-400">${timeAgo}</span>
        </div>
        <p class="rounded-xl border border-white/5 bg-slate-900/80 px-3 py-2 text-sm text-slate-100">${(r.messageSnippet || "").slice(0, 80)}</p>
        <a href="/crm?lead=${r.leadId}" class="mt-2 inline-block text-sm font-semibold text-sky-300 hover:text-sky-200">Review →</a>`;
    feed.appendChild(div);
  });
}

// ── Helpers ──
function getTimeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

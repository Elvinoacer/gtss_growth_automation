/**
 * dashboard/renderSessions.js — Real-time session-validity panel.
 *
 * renderSessions(sessions) — renders one row per platform showing its
 * current session validity: a green "Active" badge or a red "Expired"
 * badge + a "Login / Re-authenticate" button for expired sessions.
 * Clicking the re-auth button mirrors settings.js#authenticatePlatform:
 * disable the button, POST /api/sessions/authenticate/:platform, toast
 * success/failure, refresh the dashboard panel + the sidebar dots.
 *
 * The lastActive timestamp is shown as a relative "5m ago" via
 * getTimeAgo (declared in renderReplies.js, accessed by bare name).
 *
 * Cross-file dependencies (call-time only): $ (state.js),
 * PLATFORM_COLORS (state.js), getTimeAgo (renderReplies.js),
 * fetchJSON (state.js), showToast (state.js), loadStats (loadStats.js),
 * window.gtss.updateSessionDots (provided by /js/app.js).
 */

// ── Sessions ──
function renderSessions(sessions) {
  const panel = $("sessions-panel");
  panel.innerHTML = "";
  Object.entries(sessions).forEach(([platform, s]) => {
    const active = s.valid;
    const borderColor = active
      ? "border-emerald-400/40"
      : "border-rose-400/40";
    const statusBadge = active
      ? '<span class="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">Active</span>'
      : '<span class="rounded-full bg-rose-400/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300">Expired</span>';
    const lastActive = s.lastActive ? getTimeAgo(s.lastActive) : "Never";
    const color = PLATFORM_COLORS[platform] || "#999";

    const div = document.createElement("div");
    div.className = `flex items-center gap-3 rounded-2xl border ${borderColor} bg-slate-950/50 p-4 text-sm`;
    div.innerHTML = `
        <div class="w-3 h-3 rounded-full flex-shrink-0" style="background:${color}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-slate-100 capitalize">${platform}</div>
          <div class="text-[10px] text-slate-400">Last: ${lastActive}</div>
        </div>
        ${statusBadge}
        ${!active ? `<button class="reauth-btn text-[10px] font-semibold text-sky-300 hover:text-sky-200" data-platform="${platform}">Login / Re-authenticate</button>` : ""}`;
    panel.appendChild(div);
  });

  panel.querySelectorAll(".reauth-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform;
      // Mirror settings.js#authenticatePlatform exactly: disable the
      // button, show in-flight status, call the central server-side
      // authenticate endpoint, refresh the dashboard panel + sidebar
      // dots, and restore the button label afterwards.
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening browser...";
      try {
        await fetchJSON(`/api/sessions/authenticate/${platform}`, {
          method: "POST",
        });
        showToast(`${platform} session saved`, "success");
        // Refresh the dashboard's session panel + the sidebar dots.
        await loadStats();
        if (
          window.gtss &&
          typeof window.gtss.updateSessionDots === "function"
        ) {
          window.gtss.updateSessionDots();
        }
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

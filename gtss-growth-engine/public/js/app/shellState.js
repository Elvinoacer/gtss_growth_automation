async function updateSessionDots() {
  try {
    const statuses = await fetchJSON("/api/sessions/status");
    Object.entries(statuses).forEach(([platform, isActive]) => {
      const dot = document.querySelector(`[data-platform-dot="${platform}"]`);
      const row = document.querySelector(`[data-platform-row="${platform}"]`);
      if (dot) {
        dot.classList.toggle("active", Boolean(isActive));
      }
      if (row) {
        row.classList.toggle("active", Boolean(isActive));
        const pill = row.querySelector(".gtss-session-pill");
        if (pill) {
          pill.textContent = isActive ? "Connected" : "Offline";
        }
      }
    });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function updateActionBadge() {
  const badge = document.getElementById("gtss-action-badge");
  if (!badge) {
    return;
  }

  try {
    const stats = await fetchJSON("/api/stats/daily-actions");
    const limit = stats.limit || 0;
    const used = stats.used || 0;
    const ratio = limit > 0 ? used / limit : 0;

    badge.textContent = `Actions today: ${used} / ${limit} limit`;
    badge.style.setProperty("--action-ratio", `${Math.min(Math.round(ratio * 100), 100)}%`);
    badge.classList.toggle("warning", ratio >= 0.7 && ratio < 0.9);
    badge.classList.toggle("danger", ratio >= 0.9);

    const dashboardBadge = document.getElementById("nav-badge-dashboard");
    if (dashboardBadge) {
      dashboardBadge.textContent = limit ? `${Math.min(Math.round(ratio * 100), 100)}%` : "";
    }
  } catch (error) {
    badge.textContent = "Actions today: unavailable";
    badge.style.setProperty("--action-ratio", "100%");
    badge.classList.add("danger");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const { fetchJSON, showToast } = window.gtss;
  const $ = (id) => document.getElementById(id);

  const PLATFORM_COLORS = {
    linkedin: "#0077b5",
    x: "#14171a",
    instagram: "#e1306c",
    facebook: "#1877f2",
  };
  const PLATFORM_ICONS = {
    linkedin: "LinkedIn",
    x: "X",
    instagram: "Instagram",
    facebook: "Facebook",
  };
  const STAGES = [
    "discovered",
    "qualified",
    "messaged",
    "replied",
    "converted",
  ];
  const STAGE_LABELS = [
    "Discovered",
    "Qualified",
    "Messaged",
    "Replied",
    "Converted",
  ];

  let funnelChart = null;
  let statsData = null;

  init();

  async function init() {
    bindEvents();
    await loadStats();
  }

  async function loadStats() {
    try {
      statsData = await fetchJSON("/api/dashboard/stats");
      renderStatCards(statsData.leads);
      renderFunnelChart(statsData.funnel);
      renderActions(statsData.dailyActions);
      renderReplies(statsData.recentReplies);
      renderUpcoming(statsData.upcomingPosts);
      renderSessions(statsData.sessions);
      renderTemplatePerf(statsData.templatePerformance);
    } catch (e) {
      showToast("Failed to load dashboard: " + e.message, "error");
    }
  }

  // ── Stat Cards ──
  function renderStatCards(l) {
    $("stat-total").textContent = l.total;
    $("stat-delta").textContent =
      l.deltaLastWeek > 0
        ? `+${l.deltaLastWeek} this week`
        : `${l.deltaLastWeek} this week`;
    $("stat-delta").className =
      `text-body-xs mt-1 ${l.deltaLastWeek > 0 ? "text-green-600" : "text-on-surface-variant"}`;
    $("stat-qualified").textContent = l.qualified;
    $("stat-qualified-pct").textContent = `${l.qualifiedPct}% of discovered`;
    $("stat-messaged").textContent = l.messaged;
    $("stat-messaged-week").textContent = `${l.messagedThisWeek} this week`;
    $("stat-replied").textContent = l.replied;
    $("stat-reply-rate").textContent = `${l.replyRate}% reply rate`;
    $("stat-meetings").textContent = l.meetingsBooked;
    $("stat-converted").textContent = l.converted;
  }

  // ── Funnel Chart ──
  function renderFunnelChart(funnel) {
    const ctx = $("funnel-chart").getContext("2d");
    if (funnelChart) funnelChart.destroy();

    funnelChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: STAGE_LABELS,
        datasets: [
          {
            label: "All Platforms",
            data: STAGES.map((s) => funnel[s] || 0),
            backgroundColor: [
              "#60a5fa",
              "#34d399",
              "#fbbf24",
              "#a78bfa",
              "#22c55e",
            ],
            borderRadius: 4,
            barThickness: 28,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: "#e0e3e5" }, ticks: { stepSize: 1 } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function renderFunnelByPlatform(byPlatform) {
    const ctx = $("funnel-chart").getContext("2d");
    if (funnelChart) funnelChart.destroy();

    const datasets = Object.entries(byPlatform).map(([platform, data]) => ({
      label: window.gtss.formatPlatformLabel(platform) || platform,
      data: STAGES.map((s) => data[s] || 0),
      backgroundColor: PLATFORM_COLORS[platform] || "#999",
      borderRadius: 4,
      barThickness: 10,
    }));

    funnelChart = new Chart(ctx, {
      type: "bar",
      data: { labels: STAGE_LABELS, datasets },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top",
            labels: { boxWidth: 12, padding: 12, font: { size: 11 } },
          },
        },
        scales: {
          x: {
            grid: { color: "#e0e3e5" },
            ticks: { stepSize: 1 },
            stacked: false,
          },
          y: { grid: { display: false }, stacked: false },
        },
      },
    });
  }

  // ── Daily Actions ──
  function renderActions(da) {
    const panel = $("actions-panel");
    panel.innerHTML = "";
    Object.entries(da).forEach(([platform, data]) => {
      const pct =
        data.limit > 0 ? Math.round((data.used / data.limit) * 100) : 0;
      const barColor =
        pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-green-500";
      const div = document.createElement("div");
      div.className = "flex flex-col gap-1";
      div.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-body-sm font-semibold text-on-surface capitalize">${platform}</span>
          <span class="text-body-xs text-on-surface-variant">${data.used}/${data.limit}</span>
        </div>
        <div class="h-2 bg-surface-variant rounded-full overflow-hidden">
          <div class="${barColor} h-full rounded-full transition-all" style="width:${Math.min(pct, 100)}%"></div>
        </div>
        <div class="text-body-xs text-on-surface-variant">${data.byType.connections} conn · ${data.byType.dms} DMs · ${data.byType.likes} likes</div>`;
      panel.appendChild(div);
    });
  }

  // ── Recent Replies ──
  function renderReplies(replies) {
    const feed = $("replies-feed");
    feed.innerHTML = "";
    if (!replies || replies.length === 0) {
      feed.innerHTML =
        '<p class="text-body-xs text-on-surface-variant text-center py-6">No replies yet</p>';
      return;
    }
    replies.forEach((r) => {
      const timeAgo = getTimeAgo(r.repliedAt);
      const color = PLATFORM_COLORS[r.platform] || "#999";
      const div = document.createElement("div");
      div.className =
        "bg-surface border border-outline-variant rounded p-3 text-body-xs hover:border-outline transition-colors";
      div.innerHTML = `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></div>
          <span class="font-semibold text-on-surface">${r.name || "Unknown"}</span>
          ${r.company ? `<span class="text-on-surface-variant">· ${r.company}</span>` : ""}
          <span class="ml-auto text-on-surface-variant">${timeAgo}</span>
        </div>
        <p class="text-on-surface-variant bg-surface-container-low rounded px-2 py-1 text-[11px]">${(r.messageSnippet || "").slice(0, 80)}</p>
        <a href="/crm?lead=${r.leadId}" class="text-primary text-[11px] font-semibold hover:underline mt-1 inline-block">Review →</a>`;
      feed.appendChild(div);
    });
  }

  // ── Upcoming Posts ──
  function renderUpcoming(posts) {
    const container = $("upcoming-posts");
    container.innerHTML = "";
    if (!posts || posts.length === 0) {
      container.innerHTML =
        '<p class="text-body-xs text-on-surface-variant text-center py-6">No upcoming posts</p>';
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
        "bg-surface border border-outline-variant rounded p-3 text-body-xs hover:border-outline transition-colors";
      div.innerHTML = `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="flex gap-1">${dots}</div>
          <span class="ml-auto text-on-surface-variant">${time}</span>
        </div>
        <p class="text-on-surface line-clamp-2 text-[11px]">${p.bodyPreview}</p>
        <a href="/scheduler" class="text-primary text-[11px] font-semibold hover:underline mt-1 inline-block">Edit →</a>`;
      container.appendChild(div);
    });
  }

  // ── Sessions ──
  function renderSessions(sessions) {
    const panel = $("sessions-panel");
    panel.innerHTML = "";
    Object.entries(sessions).forEach(([platform, s]) => {
      const active = s.valid;
      const borderColor = active ? "border-green-400" : "border-red-300";
      const statusBadge = active
        ? '<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">Active</span>'
        : '<span class="bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">Expired</span>';
      const lastActive = s.lastActive ? getTimeAgo(s.lastActive) : "Never";
      const color = PLATFORM_COLORS[platform] || "#999";

      const div = document.createElement("div");
      div.className = `bg-surface border ${borderColor} rounded p-3 text-body-xs flex items-center gap-3`;
      div.innerHTML = `
        <div class="w-3 h-3 rounded-full flex-shrink-0" style="background:${color}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-on-surface capitalize">${platform}</div>
          <div class="text-on-surface-variant text-[10px]">Last: ${lastActive}</div>
        </div>
        ${statusBadge}
        ${!active ? `<button class="reauth-btn text-primary text-[10px] font-semibold hover:underline" data-platform="${platform}">Connect</button>` : ""}`;
      panel.appendChild(div);
    });

    panel.querySelectorAll(".reauth-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const platform = btn.dataset.platform;
        try {
          const data = await fetchJSON(
            `/api/sessions/authenticate/${platform}`,
            { method: "POST" },
          );
          showToast(data.message, "info");
        } catch (e) {
          showToast(e.message, "error");
        }
      });
    });
  }

  // ── Template Performance ──
  function renderTemplatePerf(rows) {
    const body = $("template-perf-body");
    body.innerHTML = "";
    if (!rows || rows.length === 0) {
      body.innerHTML =
        '<tr><td colspan="5" class="px-4 py-6 text-center text-on-surface-variant text-body-sm">No template data yet</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-surface-container-low transition-colors";
      tr.innerHTML = `
        <td class="px-4 py-3 text-body-sm capitalize">${r.platform}</td>
        <td class="px-4 py-3 text-body-sm">Variant ${r.templateName}</td>
        <td class="px-4 py-3 text-body-sm">${r.sent}</td>
        <td class="px-4 py-3 text-body-sm">${r.replied}</td>
        <td class="px-4 py-3 text-body-sm font-semibold">${r.acceptanceRate}%</td>`;
      body.appendChild(tr);
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

  // ── Event Binding ──
  function bindEvents() {
    // Export dropdown
    const exportBtn = $("export-btn");
    const exportDropdown = $("export-dropdown");
    exportBtn.addEventListener("click", () =>
      exportDropdown.classList.toggle("hidden"),
    );
    document.addEventListener("click", (e) => {
      if (!exportBtn.contains(e.target) && !exportDropdown.contains(e.target)) {
        exportDropdown.classList.add("hidden");
      }
    });

    // Funnel toggle
    $("funnel-all-btn").addEventListener("click", () => {
      if (!statsData) return;
      $("funnel-all-btn").className =
        "px-3 py-1 text-body-xs bg-primary text-on-primary font-semibold";
      $("funnel-platform-btn").className =
        "px-3 py-1 text-body-xs bg-surface text-on-surface-variant hover:bg-surface-variant transition-colors";
      renderFunnelChart(statsData.funnel);
    });
    $("funnel-platform-btn").addEventListener("click", () => {
      if (!statsData) return;
      $("funnel-platform-btn").className =
        "px-3 py-1 text-body-xs bg-primary text-on-primary font-semibold";
      $("funnel-all-btn").className =
        "px-3 py-1 text-body-xs bg-surface text-on-surface-variant hover:bg-surface-variant transition-colors";
      renderFunnelByPlatform(statsData.funnelByPlatform);
    });

    // Refresh actions
    $("refresh-actions-btn").addEventListener("click", async () => {
      try {
        const data = await fetchJSON("/api/dashboard/stats");
        renderActions(data.dailyActions);
        showToast("Actions refreshed", "success");
      } catch (e) {
        showToast(e.message, "error");
      }
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const { fetchJSON, showToast } = window.gtss;
  const $ = (id) => document.getElementById(id);

  const PLATFORM_COLORS = {
    linkedin: "#0077b5",
    x: "#cbd5e1",
    instagram: "#e1306c",
    facebook: "#1877f2",
  };
  const CHART_TICK_COLOR = "#cbd5e1";
  const CHART_GRID_COLOR = "rgba(148, 163, 184, 0.16)";
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
    initSocketListeners();
  }

  let _refreshTimer = null;
  function debouncedRefresh() {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(async () => {
      _refreshTimer = null;
      await loadStats();
    }, 2000);
  }

  function initSocketListeners() {
    const socket = window.gtss.getSocket();
    if (!socket) return;

    // Any module event triggers a dashboard refresh (debounced)
    const events = [
      "discovery:event",
      "qualification:event",
      "qualification:mutation",
      "automation:log",
      "messages:event",
      "messages:mutation",
      "scheduler:event",
      "crm:event",
      "crm:mutation",
    ];
    events.forEach((evt) => socket.on(evt, debouncedRefresh));
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
    const deltaPositive = l.deltaLastWeek > 0;
    const deltaClass = deltaPositive ? "text-emerald-300" : "text-slate-300";
    $("stat-total").textContent = l.total;
    $("stat-delta").textContent = deltaPositive
      ? `+${l.deltaLastWeek} this week`
      : `${l.deltaLastWeek} this week`;
    $("stat-delta").className = `mt-1 text-xs ${deltaClass}`;
    $("stat-qualified").textContent = l.qualified;
    $("stat-qualified-pct").textContent = `${l.qualifiedPct}% of discovered`;
    if ($("stat-qualified-inline")) {
      $("stat-qualified-inline").textContent = `${l.qualifiedPct}%`;
    }
    $("stat-messaged").textContent = l.messaged;
    $("stat-messaged-week").textContent = `${l.messagedThisWeek} this week`;
    $("stat-replied").textContent = l.replied;
    $("stat-reply-rate").textContent = `${l.replyRate}% reply rate`;
    if ($("stat-replied-inline")) {
      $("stat-replied-inline").textContent = l.replied;
    }
    if ($("stat-reply-rate-inline")) {
      $("stat-reply-rate-inline").textContent = `${l.replyRate}%`;
    }
    $("stat-meetings").textContent = l.meetingsBooked;
    $("stat-converted").textContent = l.converted;
    if ($("stat-delta-inline")) {
      $("stat-delta-inline").className = `text-3xl font-bold ${deltaClass}`;
      $("stat-delta-inline").textContent = deltaPositive
        ? `+${l.deltaLastWeek}`
        : `${l.deltaLastWeek}`;
    }
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
        plugins: {
          legend: { display: false, labels: { color: CHART_TICK_COLOR } },
          tooltip: {
            backgroundColor: "#0f172a",
            borderColor: "rgba(148, 163, 184, 0.18)",
            borderWidth: 1,
            titleColor: "#f8fafc",
            bodyColor: "#e2e8f0",
          },
        },
        scales: {
          x: {
            grid: { color: CHART_GRID_COLOR, drawBorder: false },
            ticks: { color: CHART_TICK_COLOR, stepSize: 1 },
          },
          y: {
            grid: { display: false },
            ticks: { color: CHART_TICK_COLOR },
          },
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
            labels: {
              boxWidth: 12,
              padding: 12,
              font: { size: 11 },
              color: CHART_TICK_COLOR,
            },
          },
          tooltip: {
            backgroundColor: "#0f172a",
            borderColor: "rgba(148, 163, 184, 0.18)",
            borderWidth: 1,
            titleColor: "#f8fafc",
            bodyColor: "#e2e8f0",
          },
        },
        scales: {
          x: {
            grid: { color: CHART_GRID_COLOR, drawBorder: false },
            ticks: { color: CHART_TICK_COLOR, stepSize: 1 },
            stacked: false,
          },
          y: {
            grid: { display: false },
            ticks: { color: CHART_TICK_COLOR },
            stacked: false,
          },
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
        pct >= 90
          ? "bg-rose-400"
          : pct >= 70
            ? "bg-amber-400"
            : "bg-emerald-400";
      const div = document.createElement("div");
      div.className =
        "flex flex-col gap-2 rounded-2xl border border-white/10 bg-slate-950/50 p-4";
      div.innerHTML = `
        <div class="flex items-center justify-between gap-3">
          <span class="text-sm font-semibold text-slate-100 capitalize">${platform}</span>
          <span class="text-xs text-slate-300">${data.used}/${data.limit}</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(pct, 100)}" aria-label="${platform} daily action usage ${pct}%">
          <div class="${barColor} h-full rounded-full transition-all" style="width:${Math.min(pct, 100)}%"></div>
        </div>
        <div class="text-xs text-slate-300">${data.byType.connections} conn · ${data.byType.dms} DMs · ${data.byType.likes} likes</div>`;
      panel.appendChild(div);
    });
  }

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

  // ── Template Performance ──
  function renderTemplatePerf(rows) {
    const body = $("template-perf-body");
    body.innerHTML = "";
    if (!rows || rows.length === 0) {
      body.innerHTML =
        '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-slate-300">No template data yet</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.className = "transition-colors hover:bg-white/5";
      tr.innerHTML = `
        <td class="px-4 py-3 text-sm capitalize text-slate-200">${r.platform}</td>
        <td class="px-4 py-3 text-sm text-slate-200">Variant ${r.templateName}</td>
        <td class="px-4 py-3 text-sm text-slate-200">${r.sent}</td>
        <td class="px-4 py-3 text-sm text-slate-200">${r.replied}</td>
        <td class="px-4 py-3 text-sm font-semibold text-emerald-300">${r.acceptanceRate}%</td>`;
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
    const activeToggleClass =
      "focus-ring rounded-full bg-sky-400 px-4 py-2 text-xs font-semibold text-slate-950 shadow-sm";
    const inactiveToggleClass =
      "focus-ring rounded-full px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/10";

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
      $("funnel-all-btn").className = activeToggleClass;
      $("funnel-platform-btn").className = inactiveToggleClass;
      renderFunnelChart(statsData.funnel);
    });
    $("funnel-platform-btn").addEventListener("click", () => {
      if (!statsData) return;
      $("funnel-platform-btn").className = activeToggleClass;
      $("funnel-all-btn").className = inactiveToggleClass;
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

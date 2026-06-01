/* ================================================================
   Campaign Detail & Telemetry – Client Controller
   ================================================================ */

(function () {
  "use strict";

  const { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

  // Extract campaign ID from injected data
  const campaignId = Number(window.__PAGE_DATA__?.campaignId);
  if (!campaignId) {
    showToast("Invalid campaign configuration.", "error");
    return;
  }

  // State
  let campaign = null;
  let connPage = 1;
  let dmPage = 1;
  const jobsLimit = 10;
  let connTotalPages = 1;
  let dmTotalPages = 1;
  let isCheckingLock = false;

  // DOM Refs
  const titleEl = document.getElementById("campaign-title");
  const platformBadge = document.getElementById("campaign-platform-badge");
  const statusBadge = document.getElementById("campaign-status-badge");
  const lockDot = document.getElementById("lock-dot");
  const lockText = document.getElementById("lock-text");
  
  // Actions
  const pauseResumeBtn = document.getElementById("pause-resume-btn");
  const pauseResumeIcon = document.getElementById("pause-resume-icon");
  const pauseResumeText = document.getElementById("pause-resume-text");
  const runConnectionBtn = document.getElementById("run-connection-btn");
  const runDmBtn = document.getElementById("run-dm-btn");

  // Widgets
  const connectionsCircle = document.getElementById("connections-svg-circle");
  const connectionsPctText = document.getElementById("connections-pct-text");
  const connectionsRatioText = document.getElementById("connections-ratio-text");
  
  const dmsCircle = document.getElementById("dms-svg-circle");
  const dmsPctText = document.getElementById("dms-pct-text");
  const dmsRatioText = document.getElementById("dms-ratio-text");

  // Stats Counters
  const statConnTotal = document.getElementById("stat-conn-total");
  const statConnAccepted = document.getElementById("stat-conn-accepted");
  const statConnSent = document.getElementById("stat-conn-sent");
  const statConnFailed = document.getElementById("stat-conn-failed");
  const statConnPending = document.getElementById("stat-conn-pending");

  const statDmTotal = document.getElementById("stat-dm-total");
  const statDmSent = document.getElementById("stat-dm-sent");
  const statDmReplied = document.getElementById("stat-dm-replied");
  const statDmFailed = document.getElementById("stat-dm-failed");
  const statDmPending = document.getElementById("stat-dm-pending");

  // Tabs
  const tabConnectionsBtn = document.getElementById("tab-connections-btn");
  const tabDmsBtn = document.getElementById("tab-dms-btn");
  const tabConnectionsContent = document.getElementById("tab-connections-content");
  const tabDmsContent = document.getElementById("tab-dms-content");

  // Tables
  const connectionsTableBody = document.getElementById("connections-table-body");
  const connEmpty = document.getElementById("conn-table-empty");
  const dmsTableBody = document.getElementById("dms-table-body");
  const dmsEmpty = document.getElementById("dms-table-empty");

  // Paging DOM
  const connPagInfo = document.getElementById("conn-pag-info");
  const connPrevBtn = document.getElementById("conn-prev-btn");
  const connNextBtn = document.getElementById("conn-next-btn");

  const dmsPagInfo = document.getElementById("dms-pag-info");
  const dmsPrevBtn = document.getElementById("dms-prev-btn");
  const dmsNextBtn = document.getElementById("dms-next-btn");

  // Telemetry Log
  const streamLogContainer = document.getElementById("stream-log-container");
  const clearStreamBtn = document.getElementById("clear-stream-btn");
  const streamAutoscroll = document.getElementById("stream-autoscroll");

  // Init
  async function init() {
    await loadCampaignDetail();
    await loadConnectionJobs(1);
    await loadDmJobs(1);
    await loadAdvisoryLock();

    // Start Lock status checker polling every 5s to reflect lock transitions
    setInterval(loadAdvisoryLock, 5000);

    // Event binding
    setupEventListeners();

    // Subscribe to campaign Socket.IO channels
    setupSocketSubscriptions();
  }

  // Setup UI Click/Tab bindings
  function setupEventListeners() {
    // Tabs Navigation
    tabConnectionsBtn.addEventListener("click", () => {
      tabConnectionsBtn.className = "flex-1 font-label-caps text-label-caps uppercase tracking-wider font-bold py-4 text-center border-b-2 border-primary text-primary transition-all";
      tabDmsBtn.className = "flex-1 font-label-caps text-label-caps uppercase tracking-wider font-bold py-4 text-center border-b-2 border-transparent text-outline hover:text-on-surface-variant transition-all";
      tabConnectionsContent.classList.remove("hidden");
      tabDmsContent.classList.add("hidden");
    });

    tabDmsBtn.addEventListener("click", () => {
      tabDmsBtn.className = "flex-1 font-label-caps text-label-caps uppercase tracking-wider font-bold py-4 text-center border-b-2 border-primary text-primary transition-all";
      tabConnectionsBtn.className = "flex-1 font-label-caps text-label-caps uppercase tracking-wider font-bold py-4 text-center border-b-2 border-transparent text-outline hover:text-on-surface-variant transition-all";
      tabDmsContent.classList.remove("hidden");
      tabConnectionsContent.classList.add("hidden");
    });

    const socket = getSocket?.() || initSocket?.();
    if (socket) {
      socket.on("campaign:status", ({ campaignId: changedCampaignId }) => {
        if (String(changedCampaignId) !== String(campaignId)) return;
        loadCampaign();
      });
    }

    // Pause / Resume outreach click handler
    pauseResumeBtn.addEventListener("click", handleTogglePause);

    // Manual outreach triggers click handlers
    runConnectionBtn.addEventListener("click", () => handleTriggerQueue("connection"));
    runDmBtn.addEventListener("click", () => handleTriggerQueue("dm"));

    // Pagination Click handlers
    connPrevBtn.addEventListener("click", () => {
      if (connPage > 1) {
        connPage--;
        loadConnectionJobs(connPage);
      }
    });
    connNextBtn.addEventListener("click", () => {
      if (connPage < connTotalPages) {
        connPage++;
        loadConnectionJobs(connPage);
      }
    });

    dmsPrevBtn.addEventListener("click", () => {
      if (dmPage > 1) {
        dmPage--;
        loadDmJobs(dmPage);
      }
    });
    dmsNextBtn.addEventListener("click", () => {
      if (dmPage < dmTotalPages) {
        dmPage++;
        loadDmJobs(dmPage);
      }
    });

    // Telemetry log clear handler
    clearStreamBtn.addEventListener("click", () => {
      streamLogContainer.innerHTML = `
        <div class="flex gap-2">
          <span class="text-slate-500 shrink-0">[System]</span>
          <span class="text-secondary shrink-0">CLEARED</span>
          <span class="text-white">Logs buffer successfully reset. Ready for next incoming telemetry events.</span>
        </div>
      `;
    });
  }

  // Socket.IO updates listeners
  function setupSocketSubscriptions() {
    const socket = getSocket();
    if (!socket) return;

    // Join Rooms
    if (typeof window.gtss.joinRoom === "function") {
      window.gtss.joinRoom(`campaigns:${campaignId}`);
      window.gtss.joinRoom("campaigns");
    } else {
      socket.emit("subscribe", `campaigns:${campaignId}`);
      socket.emit("subscribe", "campaigns");
    }

    // Capture Campaign Events
    socket.on("event", (evt) => {
      if (Number(evt.campaign_id) !== campaignId) return;

      appendTelemetryLog("event", evt);

      // Perform a silent background refresh of lists and stats
      refreshCampaignDataSilently();
    });

    // Capture Queue Processing Logs
    socket.on("queue:log", (log) => {
      // Look inside context for matching campaignId
      if (log.context && Number(log.context.campaignId) === campaignId) {
        appendTelemetryLog("log", log);
        refreshCampaignDataSilently();
      }
    });
  }

  // Refresh lists & metrics without full reloading loaders
  async function refreshCampaignDataSilently() {
    try {
      await Promise.all([
        loadCampaignDetail(true),
        loadConnectionJobs(connPage, true),
        loadDmJobs(dmPage, true),
        loadAdvisoryLock()
      ]);
    } catch (_) {}
  }

  // 1. Fetch Campaign Details
  async function loadCampaignDetail(silent = false) {
    try {
      const res = await fetchJSON(`/api/campaigns/${campaignId}`);
      campaign = res.campaign;
      if (!campaign) throw new Error("Null campaign response");

      renderHeaderInfo(campaign);
      renderStatsDashboard(campaign.metrics);
      renderProgressWidgets(campaign.metrics);
    } catch (err) {
      console.error("Failed to load details", err);
      if (!silent) {
        titleEl.textContent = "Error loading campaign details";
        showToast("Error loading campaign details: " + err.message, "error");
      }
    }
  }

  // 2. Fetch Connection Jobs list
  async function loadConnectionJobs(page = 1, silent = false) {
    try {
      if (!silent) {
        connectionsTableBody.innerHTML = `
          <tr>
            <td colspan="5" class="py-12 text-center text-outline">
              <span class="material-symbols-outlined text-3xl animate-spin">refresh</span>
              <div class="mt-2 text-xs">Fetching connections pipeline...</div>
            </td>
          </tr>
        `;
      }

      const res = await fetchJSON(`/api/campaigns/${campaignId}/connection-jobs?page=${page}&limit=${jobsLimit}`);
      const jobs = res.jobs || [];
      const pag = res.pagination || { page: 1, limit: jobsLimit, total: 0, pages: 1 };

      connPage = pag.page;
      connTotalPages = pag.pages;

      renderConnectionJobs(jobs);
      renderTablePagination(pag, "conn");
    } catch (err) {
      console.error("Failed to load connection jobs", err);
      showToast("Error loading connection jobs: " + err.message, "error");
    }
  }

  // 3. Fetch DM Jobs list
  async function loadDmJobs(page = 1, silent = false) {
    try {
      if (!silent) {
        dmsTableBody.innerHTML = `
          <tr>
            <td colspan="5" class="py-12 text-center text-outline">
              <span class="material-symbols-outlined text-3xl animate-spin">refresh</span>
              <div class="mt-2 text-xs">Fetching DM queue...</div>
            </td>
          </tr>
        `;
      }

      const res = await fetchJSON(`/api/campaigns/${campaignId}/dm-jobs?page=${page}&limit=${jobsLimit}`);
      const jobs = res.jobs || [];
      const pag = res.pagination || { page: 1, limit: jobsLimit, total: 0, pages: 1 };

      dmPage = pag.page;
      dmTotalPages = pag.pages;

      renderDmJobs(jobs);
      renderTablePagination(pag, "dm");
    } catch (err) {
      console.error("Failed to load DM jobs", err);
      showToast("Error loading DM jobs: " + err.message, "error");
    }
  }

  // 4. Fetch Advisory Lock status
  async function loadAdvisoryLock() {
    if (isCheckingLock) return;
    isCheckingLock = true;

    try {
      const lockRes = await fetchJSON("/api/campaigns/queue-status/lock");
      if (lockRes.locked || lockRes.inProgress) {
        lockDot.className = "w-2.5 h-2.5 rounded-full bg-orange-500 inline-block animate-pulse";
        lockText.textContent = "Playwright active (outreach queue running)";
        lockText.className = "text-orange-400 font-bold";
      } else {
        lockDot.className = "w-2.5 h-2.5 rounded-full bg-green-500 inline-block";
        lockText.textContent = "Outreach lock: Idle";
        lockText.className = "text-green-500 font-bold";
      }
    } catch (err) {
      // Silently ignore polling error to prevent annoying logs
    } finally {
      isCheckingLock = false;
    }
  }

  // Toggle Campaign Pause/Resume
  async function handleTogglePause() {
    if (!campaign) return;
    const isPaused = campaign.status === "paused";
    const endpoint = `/api/campaigns/${campaignId}/${isPaused ? "resume" : "pause"}`;

    try {
      pauseResumeBtn.disabled = true;
      pauseResumeText.textContent = isPaused ? "Resuming..." : "Pausing...";

      const res = await fetchJSON(endpoint, { method: "POST" });
      showToast(res.message, "success");
      
      await loadCampaignDetail();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      pauseResumeBtn.disabled = false;
    }
  }

  // Trigger outbound connection or dm queue processing run
  async function handleTriggerQueue(queueType) {
    const endpoint = queueType === "connection" ? "/api/campaigns/run-connection-queue" : "/api/campaigns/run-dm-queue";
    
    try {
      showToast(`Initiating manual run of ${queueType} queue...`, "info");
      const res = await fetchJSON(endpoint, { method: "POST" });
      
      showToast(res.message, "success");
      await loadAdvisoryLock();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // Header Details Renderer
  function renderHeaderInfo(camp) {
    titleEl.textContent = camp.name;

    // Platform Badge
    platformBadge.textContent = camp.platform;
    platformBadge.className = "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider border inline-block " + getPlatformBadgeClass(camp.platform);
    platformBadge.classList.remove("hidden");

    // Status Badge
    const statusStyle = getStatusBadgeStyle(camp.status);
    const dotSpan = statusBadge.querySelector("span:first-child");
    const labelSpan = statusBadge.querySelector("span:last-child");

    dotSpan.className = `w-2.5 h-2.5 rounded-full inline-block ${statusStyle.dotColor} ${statusStyle.pulseClass || ""}`;
    labelSpan.className = `capitalize ${statusStyle.textColor}`;
    labelSpan.textContent = camp.status;

    statusBadge.className = `inline-flex items-center gap-1.5 text-body-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusStyle.badgeBorder}`;
    statusBadge.classList.remove("hidden");

    // Action Pause/Resume button configurations
    pauseResumeBtn.disabled = false;
    if (camp.status === "paused") {
      pauseResumeIcon.textContent = "play_arrow";
      pauseResumeText.textContent = "Resume outreach";
      pauseResumeBtn.className = "bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors";
    } else {
      pauseResumeIcon.textContent = "pause";
      pauseResumeText.textContent = "Pause outreach";
      pauseResumeBtn.className = "bg-primary hover:bg-surface-tint text-on-primary font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors";
    }
  }

  // Metrics Stats Counters Renderer
  function renderStatsDashboard(metrics) {
    const conn = metrics.connection_jobs || { total: 0, by_status: {} };
    const dm = metrics.dm_jobs || { total: 0, by_status: {} };

    // Connection Stats
    const connTotal = conn.total || 0;
    const connAccepted = conn.by_status.accepted || 0;
    const connSent = conn.by_status.sent || 0;
    const connFailed = conn.by_status.failed || 0;
    const connPending = conn.by_status.pending || 0;

    statConnTotal.textContent = connTotal;
    statConnAccepted.textContent = connAccepted;
    statConnSent.textContent = connSent;
    statConnFailed.textContent = connFailed;
    statConnPending.textContent = connPending;

    // DM Stats
    const dmTotal = dm.total || 0;
    const dmSent = dm.by_status.sent || 0;
    const dmReplied = dm.by_status.replied || 0;
    const dmFailed = dm.by_status.failed || 0;
    const dmPending = (dm.by_status.pending || 0) + (dm.by_status.scheduled || 0);

    statDmTotal.textContent = dmTotal;
    statDmSent.textContent = dmSent;
    statDmReplied.textContent = dmReplied;
    statDmFailed.textContent = dmFailed;
    statDmPending.textContent = dmPending;
  }

  // Circular Completion Progress widgets Renderer
  function renderProgressWidgets(metrics) {
    const conn = metrics.connection_jobs || { total: 0, by_status: {} };
    const dm = metrics.dm_jobs || { total: 0, by_status: {} };

    const totalConn = conn.total || 0;
    const acceptedConn = conn.by_status.accepted || 0;
    const connPct = totalConn > 0 ? Math.round((acceptedConn / totalConn) * 100) : 0;

    const totalDms = dm.total || 0;
    const sentDms = dm.by_status.sent || 0;
    const dmPct = totalDms > 0 ? Math.round((sentDms / totalDms) * 100) : 0;

    // Circumference = 289
    const circumference = 289;

    // Recalculate dash offsets
    const connOffset = circumference - (connPct / 100) * circumference;
    connectionsCircle.setAttribute("stroke-dashoffset", connOffset);
    connectionsPctText.textContent = `${connPct}%`;
    connectionsRatioText.textContent = `${acceptedConn} / ${totalConn}`;

    const dmOffset = circumference - (dmPct / 100) * circumference;
    dmsCircle.setAttribute("stroke-dashoffset", dmOffset);
    dmsPctText.textContent = `${dmPct}%`;
    dmsRatioText.textContent = `${sentDms} / ${totalDms}`;
  }

  // Connection Tables Rows Renderer
  function renderConnectionJobs(jobs) {
    connectionsTableBody.innerHTML = "";
    if (jobs.length === 0) {
      connEmpty.classList.remove("hidden");
      connEmpty.classList.add("flex");
      return;
    }
    connEmpty.classList.add("hidden");
    connEmpty.classList.remove("flex");

    jobs.forEach((job) => {
      const leadName = escapeHtml(job.lead_name || "Unknown");
      const platformHandle = escapeHtml(job.profile_url || job.x_handle || "-");
      const statusClass = getJobStatusBadgeClass(job.status);
      const updatedStr = new Date(job.updated_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });

      const errorText = job.error_message 
        ? `<div class="text-[10px] text-error font-medium mt-0.5 line-clamp-1 max-w-[200px]" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</div>`
        : "";

      const row = `
        <tr class="border-b border-outline-variant/40 hover:bg-surface-variant/10 transition-colors">
          <td class="py-3 px-3 font-semibold text-on-surface align-middle">${leadName}</td>
          <td class="py-3 px-3 text-on-surface-variant font-mono-code text-xs max-w-[200px] truncate align-middle" title="${platformHandle}">${platformHandle}</td>
          <td class="py-3 px-3 align-middle">
            <span class="rounded-full px-2 py-0.5 text-[11px] font-bold inline-block capitalize ${statusClass}">
              ${escapeHtml(job.status)}
            </span>
            ${errorText}
          </td>
          <td class="py-3 px-3 text-on-surface-variant font-bold align-middle">${job.retry_count} / 3</td>
          <td class="py-3 px-3 text-on-surface-variant text-right align-middle">${updatedStr}</td>
        </tr>
      `;

      connectionsTableBody.insertAdjacentHTML("beforeend", row);
    });
  }

  // DM Tables Rows Renderer
  function renderDmJobs(jobs) {
    dmsTableBody.innerHTML = "";
    if (jobs.length === 0) {
      dmsEmpty.classList.remove("hidden");
      dmsEmpty.classList.add("flex");
      return;
    }
    dmsEmpty.classList.add("hidden");
    dmsEmpty.classList.remove("flex");

    jobs.forEach((job) => {
      const leadName = escapeHtml(job.lead_name || "Unknown");
      const platformHandle = escapeHtml(job.profile_url || job.x_handle || "-");
      const statusClass = getJobStatusBadgeClass(job.status);
      
      const timeVal = job.sent_at || job.scheduled_at;
      const timeStr = timeVal 
        ? new Date(timeVal).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "-";

      const errorText = job.error_message 
        ? `<div class="text-[10px] text-error font-medium mt-0.5 line-clamp-1 max-w-[200px]" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</div>`
        : "";

      const row = `
        <tr class="border-b border-outline-variant/40 hover:bg-surface-variant/10 transition-colors">
          <td class="py-3 px-3 font-semibold text-on-surface align-middle">${leadName}</td>
          <td class="py-3 px-3 text-on-surface-variant font-mono-code text-xs max-w-[200px] truncate align-middle" title="${platformHandle}">${platformHandle}</td>
          <td class="py-3 px-3 align-middle">
            <span class="rounded-full px-2 py-0.5 text-[11px] font-bold inline-block capitalize ${statusClass}">
              ${escapeHtml(job.status)}
            </span>
            ${errorText}
          </td>
          <td class="py-3 px-3 text-on-surface-variant font-bold align-middle">${job.retry_count} / 3</td>
          <td class="py-3 px-3 text-on-surface-variant text-right align-middle">${timeStr}</td>
        </tr>
      `;

      dmsTableBody.insertAdjacentHTML("beforeend", row);
    });
  }

  // Tab Table Pagination controllers Renderer
  function renderTablePagination(pag, type) {
    const info = document.getElementById(`${type}-pag-info`);
    const prev = document.getElementById(`${type}-prev-btn`);
    const next = document.getElementById(`${type}-next-btn`);

    info.textContent = `Page ${pag.page} of ${pag.pages || 1} (Total ${pag.total} jobs)`;
    prev.disabled = pag.page <= 1;
    next.disabled = pag.page >= pag.pages;
  }

  // Telemetry Log live appender
  function appendTelemetryLog(logType, data) {
    const time = new Date(data.created_at || data.timestamp).toLocaleTimeString([], { hour12: false });
    const line = document.createElement("div");
    line.className = "flex gap-2.5 mb-1.5";

    if (logType === "event") {
      const colorMap = {
        connection_accepted: "text-green-400 font-bold",
        connection_sent: "text-primary-fixed-dim",
        dm_sent: "text-green-500 font-bold",
        dm_replied: "text-purple-400 font-black",
        connection_failed: "text-red-400 font-bold",
        dm_failed: "text-red-400 font-bold",
        connection_skipped: "text-slate-400"
      };

      const eventColorClass = colorMap[data.event_type] || "text-blue-400";
      const metaStr = data.metadata ? `: ${escapeHtml(data.metadata.error || data.metadata.reason || data.metadata.sentAt || "")}` : "";

      line.innerHTML = `
        <span class="text-slate-500 shrink-0">[${time}]</span>
        <span class="${eventColorClass} shrink-0 w-24 uppercase font-bold">${escapeHtml(data.event_type.replace("connection_", "conn_"))}</span>
        <span class="text-slate-200">
          Lead #${data.lead_id || "-"} ➔ ${escapeHtml(data.event_type.replace(/_/g, " "))}${metaStr}
        </span>
      `;
    } else {
      // Standard queue log format
      const levelColors = {
        ERROR: "text-red-500 font-bold",
        WARN: "text-orange-400 font-bold",
        INFO: "text-slate-400 font-semibold"
      };
      const color = levelColors[data.level] || "text-slate-300";

      line.innerHTML = `
        <span class="text-slate-500 shrink-0">[${time}]</span>
        <span class="${color} shrink-0 w-24 font-semibold uppercase">${data.queue || "QUEUE"}</span>
        <span class="text-slate-300">
          [Job #${data.jobId || "-"}] ${escapeHtml(data.message)}
        </span>
      `;
    }

    streamLogContainer.appendChild(line);

    if (streamAutoscroll.checked) {
      streamLogContainer.scrollTop = streamLogContainer.scrollHeight;
    }
  }

  // Badge styles helpers
  function getPlatformBadgeClass(platform) {
    const norm = String(platform).toLowerCase();
    switch (norm) {
      case "linkedin": return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      case "instagram": return "bg-pink-500/10 text-pink-400 border-pink-500/20";
      case "facebook": return "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
      case "x":
      case "twitter": return "bg-slate-500/10 text-slate-400 border-slate-500/20";
      default: return "bg-surface-container-high text-on-surface-variant border-outline-variant";
    }
  }

  function getStatusBadgeStyle(status) {
    const norm = String(status).toLowerCase();
    switch (norm) {
      case "active":
        return {
          textColor: "text-primary",
          dotColor: "bg-primary border-primary/30",
          pulseClass: "animate-pulse",
          badgeBorder: "border-primary/20 bg-primary/5"
        };
      case "paused":
        return {
          textColor: "text-secondary",
          dotColor: "bg-secondary border-secondary/30",
          badgeBorder: "border-secondary/20 bg-secondary/5"
        };
      case "completed":
        return {
          textColor: "text-green-500",
          dotColor: "bg-green-500 border-green-500/30",
          badgeBorder: "border-green-500/20 bg-green-500/5"
        };
      case "draft":
      default:
        return {
          textColor: "text-outline",
          dotColor: "bg-outline border-outline/30",
          badgeBorder: "border-outline-variant/30 bg-surface-container"
        };
    }
  }

  function getJobStatusBadgeClass(status) {
    const norm = String(status).toLowerCase();
    switch (norm) {
      case "accepted":
      case "sent":
        return "bg-green-500/10 text-green-400 border border-green-500/20";
      case "failed":
        return "bg-red-500/10 text-red-400 border border-red-500/20";
      case "scheduled":
      case "sent_ready":
        return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
      case "running":
        return "bg-orange-500/10 text-orange-400 border border-orange-500/20 animate-pulse";
      case "pending":
      default:
        return "bg-slate-500/10 text-slate-400 border border-slate-500/20";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Start initialization
  init();
})();

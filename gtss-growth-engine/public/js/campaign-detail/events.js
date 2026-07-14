/**
 * campaign-detail/events.js — UI click/tab bindings and Socket.IO subscription
 * handlers.
 *
 * Includes: setupEventListeners, setupSocketSubscriptions.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

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

  const socket = (typeof getSocket === "function" && getSocket()) || (typeof initSocket === "function" && initSocket());
  if (socket) {
    socket.on("campaign:status", ({ campaignId: changedCampaignId }) => {
      if (String(changedCampaignId) !== String(campaignId)) return;
      loadCampaignDetail();
    });
  }

  // Pause / Resume outreach click handler
  pauseResumeBtn.addEventListener("click", handleTogglePause);

  // Stop in-flight connection/DM queue
  if (stopQueueBtn) {
    stopQueueBtn.addEventListener("click", handleStopQueue);
  }

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

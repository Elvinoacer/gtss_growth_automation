/* ================================================================
   Campaigns Listing & Management – Client Controller
   ================================================================ */

(function () {
  "use strict";

  const { fetchJSON, showToast, initSocket, getSocket } = window.gtss;

  // State
  let currentPage = 1;
  const limit = 9;
  let totalPages = 1;

  // DOM Refs
  const campaignsGrid = document.getElementById("campaigns-grid");
  const createForm = document.getElementById("create-campaign-form");
  const emptyState = document.getElementById("campaigns-empty-state");
  const refreshBtn = document.getElementById("refresh-campaigns-btn");
  const prevBtn = document.getElementById("prev-page-btn");
  const nextBtn = document.getElementById("next-page-btn");
  const paginationInfo = document.getElementById("pagination-info");

  // Init
  async function init() {
    await loadCampaigns(currentPage);

    // Setup event listeners
    if (createForm) {
      createForm.addEventListener("submit", handleCreateCampaign);
    }
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => loadCampaigns(currentPage));
    }
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (currentPage > 1) {
          currentPage--;
          loadCampaigns(currentPage);
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (currentPage < totalPages) {
          currentPage++;
          loadCampaigns(currentPage);
        }
      });
    }

    // Subscribe to campaigns updates via Socket.IO
    const socket = getSocket();
    if (socket) {
      // Join Room
      if (typeof window.gtss.joinRoom === "function") {
        window.gtss.joinRoom("campaigns");
      } else {
        socket.emit("subscribe", "campaigns");
      }

      // Listen for updates to dynamically refresh listing
      socket.on("campaign:event", (event) => {
        console.log("[SOCKET] Campaign event received in listing:", event);
        // Throttle slightly or just load queue info silently
        loadCampaigns(currentPage, true);
      });
    }
  }

  // Load Campaigns
  async function loadCampaigns(page = 1, silent = false) {
    try {
      if (!silent) {
        campaignsGrid.innerHTML = `
          <div class="col-span-full flex flex-col items-center justify-center py-12 text-center text-outline">
            <span class="material-symbols-outlined text-4xl animate-spin">refresh</span>
            <span class="mt-2 text-sm">Loading pipelines...</span>
          </div>
        `;
      }

      const res = await fetchJSON(`/api/campaigns?page=${page}&limit=${limit}`);
      const campaigns = res.campaigns || [];
      const pag = res.pagination || { page: 1, limit, total: 0, pages: 1 };

      currentPage = pag.page;
      totalPages = pag.pages;

      renderCampaigns(campaigns);
      renderPagination(pag);
    } catch (err) {
      console.error("Failed to load campaigns", err);
      showToast("Error loading campaigns: " + err.message, "error");
    }
  }

  // Render Campaigns
  function renderCampaigns(campaigns) {
    if (!campaignsGrid) return;
    campaignsGrid.innerHTML = "";

    if (campaigns.length === 0) {
      emptyState.classList.remove("hidden");
      emptyState.classList.add("flex");
      return;
    }

    emptyState.classList.add("hidden");
    emptyState.classList.remove("flex");

    campaigns.forEach((campaign) => {
      // Stats calculating — the backend returns
      //   stats.connection_jobs = { total, by_status: { accepted, sent, ... } }
      //   stats.dm_jobs         = { total, by_status: { sent, replied, ... } }
      // We default to an empty shape so the listing cards render "0 / 0 (0%)"
      // before any jobs have been enqueued (e.g., for draft campaigns).
      const stats = campaign.stats || {
        connection_jobs: { total: 0, by_status: {} },
        dm_jobs: { total: 0, by_status: {} },
      };

      // Extract details
      const connByStatus = stats.connection_jobs.by_status || {};
      const totalConn = stats.connection_jobs.total || 0;
      const acceptedConn = connByStatus.accepted || 0;
      const connPct = totalConn > 0 ? Math.round((acceptedConn / totalConn) * 100) : 0;

      const dmByStatus = stats.dm_jobs.by_status || {};
      const totalDms = stats.dm_jobs.total || 0;
      const sentDms = dmByStatus.sent || 0;
      const dmPct = totalDms > 0 ? Math.round((sentDms / totalDms) * 100) : 0;

      // Platform badge style mapping
      const platformStyle = getPlatformBadgeStyle(campaign.platform);

      // Status indicator style mapping
      const statusStyle = getStatusStyle(campaign.status);

      const formattedDate = new Date(campaign.created_at).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric"
      });

      const cardHtml = `
        <div class="group bg-surface-container border border-outline-variant hover:border-primary/50 rounded-lg p-5 flex flex-col justify-between shadow-sm hover:shadow-md transition-all cursor-pointer relative" 
             onclick="window.location.href='/campaigns/${campaign.id}'">
          
          <!-- Header -->
          <div class="flex justify-between items-start mb-4">
            <div>
              <h3 class="font-bold text-on-surface text-base group-hover:text-primary transition-colors line-clamp-1" title="${escapeHtml(campaign.name)}">
                ${escapeHtml(campaign.name)}
              </h3>
              <span class="text-body-xs text-on-surface-variant">Created on ${formattedDate}</span>
            </div>
            <span class="${platformStyle.badgeClass} rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase border">
              ${escapeHtml(campaign.platform)}
            </span>
          </div>

          <!-- Progress Stats Grid -->
          <div class="space-y-3 mb-4">
            <!-- Connection Progress -->
            <div>
              <div class="flex justify-between text-body-xs font-semibold text-on-surface-variant mb-1">
                <span>Connections accepted</span>
                <span>${acceptedConn} / ${totalConn} (${connPct}%)</span>
              </div>
              <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-primary rounded-full transition-all" style="width: ${connPct}%"></div>
              </div>
            </div>

            <!-- DM Progress -->
            <div>
              <div class="flex justify-between text-body-xs font-semibold text-on-surface-variant mb-1">
                <span>DMs successfully sent</span>
                <span>${sentDms} / ${totalDms} (${dmPct}%)</span>
              </div>
              <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                <div class="h-full bg-surface-tint rounded-full transition-all" style="width: ${dmPct}%"></div>
              </div>
            </div>
          </div>

          <!-- Footer Status -->
          <div class="flex justify-between items-center mt-3 pt-3 border-t border-outline-variant/40">
            <div class="flex items-center gap-1.5 text-body-xs font-semibold ${statusStyle.textColor}">
              <span class="w-2.5 h-2.5 rounded-full ${statusStyle.dotColor} inline-block ${statusStyle.pulseClass || ''}"></span>
              <span class="capitalize">${escapeHtml(campaign.status)}</span>
            </div>
            <span class="text-primary group-hover:translate-x-1 transition-transform flex items-center font-bold text-body-xs">
              Configure <span class="material-symbols-outlined text-sm font-black ml-0.5">chevron_right</span>
            </span>
          </div>

        </div>
      `;

      campaignsGrid.insertAdjacentHTML("beforeend", cardHtml);
    });
  }

  // Pagination Helper
  function renderPagination(pag) {
    if (!paginationInfo) return;
    paginationInfo.textContent = `Showing page ${pag.page} of ${pag.pages || 1} (Total ${pag.total} pipelines)`;
    
    prevBtn.disabled = pag.page <= 1;
    nextBtn.disabled = pag.page >= pag.pages;
  }

  // Platform style mapping
  function getPlatformBadgeStyle(platform) {
    const norm = String(platform).toLowerCase();
    switch (norm) {
      case "linkedin":
        return { badgeClass: "bg-blue-500/10 text-blue-400 border-blue-500/20" };
      case "instagram":
        return { badgeClass: "bg-pink-500/10 text-pink-400 border-pink-500/20" };
      case "facebook":
        return { badgeClass: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" };
      case "x":
      case "twitter":
        return { badgeClass: "bg-slate-500/10 text-slate-400 border-slate-500/20" };
      default:
        return { badgeClass: "bg-surface-container-high text-on-surface-variant border-outline-variant" };
    }
  }

  // Status style mapping
  function getStatusStyle(status) {
    const norm = String(status).toLowerCase();
    switch (norm) {
      case "active":
        return {
          textColor: "text-primary",
          dotColor: "bg-primary border-primary/30",
          pulseClass: "animate-pulse"
        };
      case "paused":
        return {
          textColor: "text-secondary",
          dotColor: "bg-secondary border-secondary/30"
        };
      case "completed":
        return {
          textColor: "text-green-500",
          dotColor: "bg-green-500 border-green-500/30"
        };
      case "draft":
      default:
        return {
          textColor: "text-outline",
          dotColor: "bg-outline border-outline/30"
        };
    }
  }

  // Create Campaign Action
  async function handleCreateCampaign(e) {
    e.preventDefault();

    const nameInput = document.getElementById("campaign-name");
    const platformInput = document.getElementById("campaign-platform");

    const name = nameInput.value.trim();
    const platform = platformInput.value;

    if (!name) {
      showToast("Please enter a campaign name.", "warn");
      return;
    }

    try {
      showToast("Initiating outreach campaign...", "info");
      const res = await fetchJSON("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, platform })
      });

      showToast("Campaign pipeline successfully created!", "success");
      
      // Clear inputs
      nameInput.value = "";
      
      // The backend returns { success, campaign: { id, ... } } — read the id
      // from the campaign object so the user lands on the detail page.
      const newCampaignId = res && res.campaign ? res.campaign.id : (res && res.campaignId);
      if (newCampaignId) {
        setTimeout(() => {
          window.location.href = `/campaigns/${newCampaignId}`;
        }, 800);
      } else {
        await loadCampaigns(1);
      }
    } catch (err) {
      showToast("Creation failed: " + err.message, "error");
    }
  }

  // HTML escape helper
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Initialize
  init();
})();

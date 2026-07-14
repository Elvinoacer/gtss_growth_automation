/**
 * campaign-detail/api.js — Backend API calls and outreach action handlers.
 *
 * Includes: refreshCampaignDataSilently, loadCampaignDetail, loadConnectionJobs,
 * loadDmJobs, loadAdvisoryLock, handleTogglePause, handleTriggerQueue.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// Refresh lists & metrics without showing loaders (called from socket events).
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

// 4. Fetch Advisory Lock status (polled every 5s to reflect lock transitions)
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

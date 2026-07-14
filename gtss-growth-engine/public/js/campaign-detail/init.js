/**
 * campaign-detail/init.js — Boot function and the init() invocation.
 *
 * Loaded last by campaign-detail.js (the document.write loader). The init()
 * function orchestrates the initial data load, the 5-second advisory-lock
 * poller, and the event/socket subscriptions.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits. The IIFE-wrapped early `return` (when campaignId is invalid) is
 * preserved here as an early `return` inside init() — behaviorally identical
 * because init() is the only entry point.
 */

"use strict";

// Init
async function init() {
  // Abort if the page was loaded without a valid campaignId (preserves the
  // original IIFE-level early-return semantics).
  if (!campaignId) {
    showToast("Invalid campaign configuration.", "error");
    return;
  }

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

// Start initialization
init();

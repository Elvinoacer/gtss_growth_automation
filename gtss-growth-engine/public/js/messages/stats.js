/**
 * messages/stats.js — Stats loader for the Message Generator page.
 *
 * Fetches /api/messages/stats and updates the per-status counters (stat
 * pending/approved/sent/skipped/followups/unscored-qualified), the per-tab
 * counts, the char-limit table (used by getCharLimitForPlatform in
 * helpers.js), and the unscored-qualified help note. Toggles a friendly
 * message explaining whether qualified leads still need scoring.
 *
 * Exposes (via global scope):
 *   - loadStats()  — async, called on page init and after every action
 *                    that mutates lead status (approve/skip/regenerate)
 *
 * Depends on (from messages/state.js, loaded earlier):
 *   - fetchJSON, statPending, statApproved, statSent, statSkipped,
 *     statFollowups, statUnscoredQualified, unscoredQualifiedNote,
 *     tabPending, tabApprovedCount, tabSent, tabFollowups, charLimits
 */

async function loadStats() {
  try {
    const stats = await fetchJSON("/api/messages/stats");
    statPending.textContent = stats.pending;
    statApproved.textContent = stats.approved;
    statSent.textContent = stats.sent;
    statSkipped.textContent = stats.skipped;
    statFollowups.textContent = stats.followUps;
    if (statUnscoredQualified) {
      statUnscoredQualified.textContent = stats.unscored_qualified || 0;
    }
    tabPending.textContent = stats.pending;
    tabApprovedCount.textContent = stats.approved;
    tabSent.textContent = stats.sent;
    tabFollowups.textContent = stats.followUps;

    if (stats.charLimits) charLimits = stats.charLimits;
    if (unscoredQualifiedNote) {
      unscoredQualifiedNote.textContent =
        stats.unscored_qualified > 0
          ? `${stats.unscored_qualified} qualified lead(s) still have no AI score and will be included in Generate All.`
          : "All qualified leads already have AI scores.";
    }

    // Always keep the Retry button visible. Only disable while a bulk job
    // is running — never grey it out just because server counts lag the
    // table (Template badges in the grid are the ground truth for the user).
    const fallbackLeads = Number(stats.fallback_leads || 0);
    const fallbackMessages = Number(stats.fallback_messages || 0);
    updateRetryFallbacksButton(fallbackLeads, fallbackMessages);
  } catch (err) {
    console.error("Failed to load stats", err);
    updateRetryFallbacksButton(null, null, {
      statsFailed: true,
    });
  }
}

/**
 * Sync Retry All Fallbacks badge + enabled state.
 * @param {number|null} fallbackLeads
 * @param {number|null} fallbackMessages
 * @param {{ statsFailed?: boolean, fromTable?: boolean }} [opts]
 */
function updateRetryFallbacksButton(
  fallbackLeads,
  fallbackMessages,
  opts = {},
) {
  if (!retryFallbacksBtn) return;

  retryFallbacksBtn.style.display = "";

  // Prefer server counts; fall back to scanning the currently loaded table
  // so the badge matches what the operator literally sees on screen.
  let leads = Number(fallbackLeads || 0);
  let msgs = Number(fallbackMessages || 0);

  if (
    (opts.fromTable || leads === 0) &&
    Array.isArray(cachedMessages) &&
    cachedMessages.length > 0
  ) {
    const templateMsgs = cachedMessages.filter((m) => {
      const g = String(m.generated_by || "")
        .trim()
        .toLowerCase();
      return (
        (m.status === "pending" ||
          m.status === "approved" ||
          m.status === "draft") &&
        (g === "template" || g === "template-fallback")
      );
    });
    if (templateMsgs.length > 0) {
      msgs = Math.max(msgs, templateMsgs.length);
      const leadIds = new Set(templateMsgs.map((m) => m.lead_id));
      leads = Math.max(leads, leadIds.size);
    }
  }

  const hasFallbacks = leads > 0 || msgs > 0;

  // ONLY bulk-job-running disables the button. Count=0 still leaves it
  // clickable so the operator can force a server re-scan / retry.
  retryFallbacksBtn.disabled = Boolean(isBulkGenRunning);

  if (opts.statsFailed) {
    retryFallbacksBtn.title =
      "Stats failed to load — click to try retrying template fallbacks anyway.";
  } else if (isBulkGenRunning) {
    retryFallbacksBtn.title = "A bulk generation job is already running…";
  } else if (hasFallbacks) {
    retryFallbacksBtn.title = `Re-run Gemini (API → Web → template) for ${leads || "these"} lead(s) with Template / Template fallback drafts.`;
  } else {
    retryFallbacksBtn.title =
      "No template drafts detected by the server. If you still see Template badges, click anyway — the job will re-scan.";
  }

  if (retryFallbacksCount) {
    if (!hasFallbacks) {
      retryFallbacksCount.textContent = "0";
    } else if (msgs > leads && leads > 0) {
      retryFallbacksCount.textContent = `${leads} leads · ${msgs} msgs`;
    } else {
      retryFallbacksCount.textContent = String(leads || msgs);
    }
  }
}

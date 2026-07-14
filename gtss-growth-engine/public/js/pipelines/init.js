/**
 * pipelines/init.js — Page-load initialization for the Pipelines page.
 *
 * Boots the initial data fetch, starts the Socket.IO subscription, and sets
 * up the defensive polling fallbacks. Runs on DOMContentLoaded (i.e., once
 * the DOM is fully parsed, which is guaranteed to be after every split file
 * has finished loading via the pipelines.js document.write loader).
 */

/* global gtss, io */

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadPipelines();
  loadHealth();
  initPipelineSocket();
  // Refresh health every 30 seconds
  setInterval(loadHealth, 30_000);

  // Polling fallback: refresh pipelines every 15 seconds as a safety net.
  // The previous 8s interval was too aggressive — combined with socket
  // events it caused the page to re-render twice in quick succession,
  // which the user perceived as "flickering while typing". Now we poll
  // less aggressively (15s) and rely on the socket for instant updates.
  // The polling itself is non-destructive (in-place patch) so even when
  // it does fire mid-typing, the user won't notice.
  //
  // If the socket connection drops, the user still gets updates within
  // 15s — acceptable for a defensive fallback.
  setInterval(loadPipelines, 15_000);
});

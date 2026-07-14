/**
 * dashboard/socketListeners.js — Socket.IO-driven refresh.
 *
 * Subscribes to every cross-module event (discovery / qualification /
 * automation / messages / scheduler / crm) on the shared GTSS socket.
 * Any such event triggers a debounced full-dashboard refresh so the
 * stats stay live without re-fetching on every single event.
 *
 * Exposes:
 *   - debouncedRefresh()    — coalesces multiple events within 2s into
 *                             a single loadStats() call (no-op if a
 *                             refresh is already queued).
 *   - initSocketListeners() — subscribes the shared socket to every
 *                             module event, wiring each to
 *                             debouncedRefresh. No-op if the socket
 *                             isn't available (graceful degradation —
 *                             the page still loads, just doesn't get
 *                             live updates).
 *
 * `let _refreshTimer` is module-private to the debouncer (only ever
 * read/written by debouncedRefresh) — kept here next to its sole user,
 * same convention as scheduler/instagram.js's `let dragSrcEl`.
 *
 * Cross-file dependencies (call-time only): loadStats (loadStats.js).
 */

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

/**
 * campaign-detail/renderStats.js — Stats counters and circular completion
 * progress widget renderers.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// Metrics Stats Counters Renderer
// Connection progress is "initiated" only (invite/follow sent). We do not
// claim to detect whether the recipient accepted the request — that is
// confirmed manually outside the product.
function renderStatsDashboard(metrics) {
  const conn = metrics.connection_jobs || { total: 0, by_status: {} };
  const dm = metrics.dm_jobs || { total: 0, by_status: {} };

  // Connection Stats — "sent" = we initiated; "accepted" is legacy already-connected
  // skip (not "they accepted our invite").
  const connTotal = conn.total || 0;
  const connSent = conn.by_status.sent || 0;
  const connSkipped = conn.by_status.accepted || 0;
  const connFailed = conn.by_status.failed || 0;
  const connPending =
    (conn.by_status.pending || 0) + (conn.by_status.running || 0);

  if (statConnTotal) statConnTotal.textContent = connTotal;
  if (statConnSent) statConnSent.textContent = connSent;
  if (statConnSkipped) statConnSkipped.textContent = connSkipped;
  if (statConnFailed) statConnFailed.textContent = connFailed;
  if (statConnPending) statConnPending.textContent = connPending;

  // DM Stats
  const dmTotal = dm.total || 0;
  const dmSent = dm.by_status.sent || 0;
  const dmReplied = dm.by_status.replied || 0;
  const dmFailed = dm.by_status.failed || 0;
  const dmPending = (dm.by_status.pending || 0) + (dm.by_status.scheduled || 0);

  if (statDmTotal) statDmTotal.textContent = dmTotal;
  if (statDmSent) statDmSent.textContent = dmSent;
  if (statDmReplied) statDmReplied.textContent = dmReplied;
  if (statDmFailed) statDmFailed.textContent = dmFailed;
  if (statDmPending) statDmPending.textContent = dmPending;
}

// Circular Completion Progress widgets Renderer
function renderProgressWidgets(metrics) {
  const conn = metrics.connection_jobs || { total: 0, by_status: {} };
  const dm = metrics.dm_jobs || { total: 0, by_status: {} };

  const totalConn = conn.total || 0;
  // Initiated = invites/follows we sent (plus legacy already-connected skips).
  const initiatedConn =
    (conn.by_status.sent || 0) + (conn.by_status.accepted || 0);
  const connPct =
    totalConn > 0 ? Math.round((initiatedConn / totalConn) * 100) : 0;

  const totalDms = dm.total || 0;
  const sentDms = dm.by_status.sent || 0;
  const dmPct = totalDms > 0 ? Math.round((sentDms / totalDms) * 100) : 0;

  // Circumference = 289
  const circumference = 289;

  // Recalculate dash offsets
  const connOffset = circumference - (connPct / 100) * circumference;
  if (connectionsCircle) {
    connectionsCircle.setAttribute("stroke-dashoffset", connOffset);
  }
  if (connectionsPctText) connectionsPctText.textContent = `${connPct}%`;
  if (connectionsRatioText) {
    connectionsRatioText.textContent = `${initiatedConn} / ${totalConn}`;
  }

  const dmOffset = circumference - (dmPct / 100) * circumference;
  if (dmsCircle) dmsCircle.setAttribute("stroke-dashoffset", dmOffset);
  if (dmsPctText) dmsPctText.textContent = `${dmPct}%`;
  if (dmsRatioText) dmsRatioText.textContent = `${sentDms} / ${totalDms}`;
}

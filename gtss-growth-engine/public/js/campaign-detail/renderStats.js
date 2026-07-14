/**
 * campaign-detail/renderStats.js — Stats counters and circular completion
 * progress widget renderers.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

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

/**
 * dashboard/loadStats.js — Top-level dashboard data fetcher.
 *
 * loadStats() — GET /api/dashboard/stats, then fan out to every render*
 * function: stat cards, funnel chart, daily-actions panel, recent
 * replies feed, upcoming posts, sessions panel, template-performance
 * table. Toasts an error if the fetch fails.
 *
 * Cross-file dependencies (call-time only): fetchJSON (state.js),
 * showToast (state.js), renderStatCards, renderFunnelChart,
 * renderActions, renderReplies, renderUpcoming, renderSessions,
 * renderTemplatePerf (the various render*.js files).
 */

async function loadStats() {
  try {
    statsData = await fetchJSON("/api/dashboard/stats");
    renderStatCards(statsData.leads);
    renderFunnelChart(statsData.funnel);
    renderActions(statsData.dailyActions);
    renderReplies(statsData.recentReplies);
    renderUpcoming(statsData.upcomingPosts);
    renderSessions(statsData.sessions);
    renderTemplatePerf(statsData.templatePerformance);
  } catch (e) {
    showToast("Failed to load dashboard: " + e.message, "error");
  }
}

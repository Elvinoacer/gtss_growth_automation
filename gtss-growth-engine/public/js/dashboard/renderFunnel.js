/**
 * dashboard/renderFunnel.js — Outreach funnel Chart.js bar chart.
 *
 * renderFunnelChart(funnel) — single-dataset horizontal bar chart of
 * the 5 funnel stages (Discovered → Qualified → Messaged → Replied →
 * Converted) across ALL platforms combined. Destroys any prior
 * funnelChart instance before drawing so we never leak Chart.js
 * canvases on re-render.
 *
 * renderFunnelByPlatform(byPlatform) — multi-dataset variant: one bar
 * per platform per stage, color-coded by PLATFORM_COLORS. Toggled on
 * when the user clicks the "By Platform" funnel toggle (see events.js).
 *
 * Cross-file dependencies (call-time only): $ (state.js), STAGE_LABELS,
 * STAGES, CHART_TICK_COLOR, CHART_GRID_COLOR, PLATFORM_COLORS (state.js),
 * funnelChart (state.js — reassigned here), window.gtss.formatPlatformLabel
 * (provided by /js/app.js). Chart is the global Chart.js constructor
 * loaded via a <script> tag in dashboard.html's <head>.
 */

// ── Funnel Chart ──
function renderFunnelChart(funnel) {
  const ctx = $("funnel-chart").getContext("2d");
  if (funnelChart) funnelChart.destroy();

  funnelChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: STAGE_LABELS,
      datasets: [
        {
          label: "All Platforms",
          data: STAGES.map((s) => funnel[s] || 0),
          backgroundColor: [
            "#60a5fa",
            "#34d399",
            "#fbbf24",
            "#a78bfa",
            "#22c55e",
          ],
          borderRadius: 4,
          barThickness: 28,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false, labels: { color: CHART_TICK_COLOR } },
        tooltip: {
          backgroundColor: "#0f172a",
          borderColor: "rgba(148, 163, 184, 0.18)",
          borderWidth: 1,
          titleColor: "#f8fafc",
          bodyColor: "#e2e8f0",
        },
      },
      scales: {
        x: {
          grid: { color: CHART_GRID_COLOR, drawBorder: false },
          ticks: { color: CHART_TICK_COLOR, stepSize: 1 },
        },
        y: {
          grid: { display: false },
          ticks: { color: CHART_TICK_COLOR },
        },
      },
    },
  });
}

function renderFunnelByPlatform(byPlatform) {
  const ctx = $("funnel-chart").getContext("2d");
  if (funnelChart) funnelChart.destroy();

  const datasets = Object.entries(byPlatform).map(([platform, data]) => ({
    label: window.gtss.formatPlatformLabel(platform) || platform,
    data: STAGES.map((s) => data[s] || 0),
    backgroundColor: PLATFORM_COLORS[platform] || "#999",
    borderRadius: 4,
    barThickness: 10,
  }));

  funnelChart = new Chart(ctx, {
    type: "bar",
    data: { labels: STAGE_LABELS, datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 12,
            padding: 12,
            font: { size: 11 },
            color: CHART_TICK_COLOR,
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          borderColor: "rgba(148, 163, 184, 0.18)",
          borderWidth: 1,
          titleColor: "#f8fafc",
          bodyColor: "#e2e8f0",
        },
      },
      scales: {
        x: {
          grid: { color: CHART_GRID_COLOR, drawBorder: false },
          ticks: { color: CHART_TICK_COLOR, stepSize: 1 },
          stacked: false,
        },
        y: {
          grid: { display: false },
          ticks: { color: CHART_TICK_COLOR },
          stacked: false,
        },
      },
    },
  });
}

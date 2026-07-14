/**
 * dashboard/state.js — Shared state for the dashboard page.
 *
 * Loaded FIRST. Provides:
 *   - fetchJSON, showToast destructured from window.gtss (the shared API
 *     exported by /js/app.js — which has finished loading all its split
 *     files before this loader runs, so window.gtss is populated by the
 *     time this statement executes)
 *   - $ helper (getElementById shorthand — used by every render* file
 *     and by events.js)
 *   - Theme constants: PLATFORM_COLORS, CHART_TICK_COLOR,
 *     CHART_GRID_COLOR, PLATFORM_ICONS
 *   - Funnel constants: STAGES (raw keys), STAGE_LABELS (display labels)
 *   - Mutable page state: funnelChart (Chart.js instance, replaced on
 *     every re-render), statsData (cached dashboard-stats payload so
 *     the funnel toggle buttons can re-render without re-fetching)
 *
 * Cross-file dependencies: none at parse time. window.gtss must exist
 * (provided by /js/app.js loading earlier in the page).
 */

const { fetchJSON, showToast } = window.gtss;
const $ = (id) => document.getElementById(id);

const PLATFORM_COLORS = {
  linkedin: "#0077b5",
  x: "#cbd5e1",
  instagram: "#e1306c",
  facebook: "#1877f2",
};
const CHART_TICK_COLOR = "#cbd5e1";
const CHART_GRID_COLOR = "rgba(148, 163, 184, 0.16)";
const PLATFORM_ICONS = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
};
const STAGES = [
  "discovered",
  "qualified",
  "messaged",
  "replied",
  "converted",
];
const STAGE_LABELS = [
  "Discovered",
  "Qualified",
  "Messaged",
  "Replied",
  "Converted",
];

let funnelChart = null;
let statsData = null;

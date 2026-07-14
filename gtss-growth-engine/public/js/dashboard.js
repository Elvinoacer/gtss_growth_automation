/* global Chart, gtss */
/**
 * dashboard.js — Dashboard page (module loader)
 *
 * The dashboard is the post-login landing page. It shows:
 *   - Top KPI stat cards (total leads, delta this week, qualified,
 *     messaged, replied, meetings, converted) — renderStatCards
 *   - Outreach funnel Chart.js bar chart (All-Platforms vs By-Platform
 *     toggle) — renderFunnelChart / renderFunnelByPlatform
 *   - Per-platform daily-actions progress bars (used / limit + per-type
 *     breakdown) — renderActions
 *   - Recent replies feed (one card per recent inbound reply with a
 *     "Review →" link to CRM) — renderReplies
 *   - Upcoming scheduled posts feed — renderUpcoming
 *   - Real-time session-validity panel (Active / Expired badges +
 *     "Login / Re-authenticate" button per platform) — renderSessions
 *   - Template A/B performance table (sent / replied / acceptance-rate
 *     per (platform, variant)) — renderTemplatePerf
 *   - Onboarding Quick Start card (dismissible via localStorage) —
 *     initQuickStartDismissal
 *   - Socket.IO-driven debounced refresh (any module event → reload
 *     stats) — initSocketListeners
 *
 * This file is a thin loader. The actual UI code has been split into
 * thematic files in the dashboard/ subdirectory for maintainability
 * (each <500 lines). Each split file is loaded synchronously via
 * document.write() during the initial page parse, preserving the
 * original single-<script> behavior — the HTML still references
 * `/js/dashboard.js`, and every split file shares the same global
 * scope exactly as the original classic <script> did.
 *
 * The original dashboard.js wrapped its ENTIRE 523-line body in a
 * single `document.addEventListener("DOMContentLoaded", () => { ... })`
 * callback. To split into multiple classic scripts that share globals,
 * every `const`/`let` and every `function` declaration was hoisted out
 * of the callback into the top-level global scope of the split files.
 * The DOMContentLoaded listener itself lives in init.js (the last file
 * loaded) so the relative ordering with app.js's own DOMContentLoaded
 * listener (initShell) is unchanged: app.js registers first → initShell
 * fires first → dashboard's init fires second.
 *
 * File manifest (loaded in dependency order):
 *   dashboard/state.js            — fetchJSON/showToast destructure from
 *                                   window.gtss, $ helper, theme/funnel
 *                                   constants, funnelChart + statsData
 *                                   mutable state. Loaded FIRST.
 *   dashboard/socketListeners.js  — _refreshTimer let, debouncedRefresh,
 *                                   initSocketListeners (deps: loadStats
 *                                   at call time)
 *   dashboard/loadStats.js        — loadStats (deps: render* + fetchJSON
 *                                   + showToast at call time)
 *   dashboard/renderStatCards.js  — renderStatCards (deps: $)
 *   dashboard/renderFunnel.js     — renderFunnelChart,
 *                                   renderFunnelByPlatform (deps: $,
 *                                   STAGES, STAGE_LABELS, PLATFORM_COLORS,
 *                                   CHART_* theme consts, funnelChart,
 *                                   window.gtss.formatPlatformLabel)
 *   dashboard/renderActions.js    — renderActions (deps: $)
 *   dashboard/renderReplies.js    — renderReplies, getTimeAgo helper
 *                                   (deps: $, PLATFORM_COLORS)
 *   dashboard/renderUpcoming.js   — renderUpcoming (deps: $,
 *                                   PLATFORM_COLORS)
 *   dashboard/renderSessions.js   — renderSessions (deps: $,
 *                                   PLATFORM_COLORS, getTimeAgo,
 *                                   fetchJSON, showToast, loadStats,
 *                                   window.gtss.updateSessionDots)
 *   dashboard/renderTemplatePerf.js — renderTemplatePerf (deps: $)
 *   dashboard/events.js           — bindEvents (deps: $, statsData,
 *                                   renderFunnelChart,
 *                                   renderFunnelByPlatform,
 *                                   renderActions, fetchJSON, showToast)
 *   dashboard/quickStart.js       — initQuickStartDismissal (deps:
 *                                   showToast)
 *   dashboard/init.js             — init() async function + DOMContentLoaded
 *                                   listener that calls init(). Loaded
 *                                   LAST — registers the boot callback.
 *
 * Original dashboard.js was ~523 lines; this loader is the only file
 * the HTML references directly (see public/pages/dashboard.html line
 * 76).
 */

(function () {
  // The split files in dependency order. state.js must load first (it
  // declares every shared `const`/`let` binding in the global lexical
  // environment, including the `const { fetchJSON, showToast } =
  // window.gtss` destructure that other split files reference by bare
  // name). init.js must load last (it registers the DOMContentLoaded
  // boot callback that calls init(), which in turn calls bindEvents /
  // initQuickStartDismissal / loadStats / initSocketListeners — all
  // declared in earlier-loaded split files). The mid-list ordering
  // among the render* files is not strictly load-sensitive (their
  // cross-file references happen at function-call time, by which point
  // every script has loaded), but the chosen order roughly follows the
  // dependency DAG for readability: state → realtime → loadStats →
  // every render* (in the order loadStats calls them) → events →
  // quickStart → init.
  var files = [
    'dashboard/state.js',
    'dashboard/socketListeners.js',
    'dashboard/loadStats.js',
    'dashboard/renderStatCards.js',
    'dashboard/renderFunnel.js',
    'dashboard/renderActions.js',
    'dashboard/renderReplies.js',
    'dashboard/renderUpcoming.js',
    'dashboard/renderSessions.js',
    'dashboard/renderTemplatePerf.js',
    'dashboard/events.js',
    'dashboard/quickStart.js',
    'dashboard/init.js'
  ];

  // Resolve the base URL of THIS script (dashboard.js) so the split
  // files load from the same directory regardless of how the app is
  // mounted. `document.currentScript.src` is e.g. "/js/dashboard.js"
  // (or an absolute URL like "http://host/js/dashboard.js"); stripping
  // the trailing "dashboard.js" leaves the "/js/" base, so e.g.
  // "dashboard/state.js" resolves to "/js/dashboard/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/dashboard\.js$/, '')
    : 'js/';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time DOMContentLoaded fires" guarantee.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();

/**
 * renderer/init.js — launch-time boot calls.
 *
 * The final script in the loader's manifest. Runs the asynchronous
 * loaders + initial polls AFTER every other split file has loaded and
 * registered its top-level event listeners. The order is:
 *   1. loadInitialLogs() — pull the backend log buffer into the Logs pane.
 *   2. refreshStatus()   — populate the hero card immediately (don't wait
 *      up to 1.5s for the first setInterval tick).
 *   3. loadAboutData()   — populate runtime + data-folder fields in About.
 *   4. pollSessionsOnce() — kick the topbar session badge so it populates
 *      as soon as the window opens (in case CDP is already running from a
 *      previous session). Async + silent on failure.
 *   5. updateSessionsHealthBadge() — render the badge in its initial "—"
 *      state immediately so it doesn't flash empty before the first poll
 *      resolves. Replaced as soon as pollSessionsOnce returns.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window */

loadInitialLogs();
refreshStatus();
loadAboutData();
// Kick off an initial sessions poll so the topbar badge populates as
// soon as the launcher window opens (in case CDP is already running
// from a previous session and the sessions are already detectable).
// The poll is async and silent on failure — no UI disruption if CDP
// isn't up yet.
pollSessionsOnce().catch(() => {});
// Render the badge in its initial "—" state immediately so it doesn't
// flash empty before the first poll resolves. updateSessionsHealthBadge()
// will replace it as soon as pollSessionsOnce returns.
updateSessionsHealthBadge();

/**
 * Browser Base — Active Browser State Tracking
 * ACTIVE_BROWSER_STATES, INVALIDATED_PLATFORMS, trackBrowserState,
 * markAutomationSessionInvalid — module-level registries of currently-open
 * browser states (so closeAllBrowsers can sweep them on shutdown) and the
 * set of platforms whose auth was invalidated mid-run (so closeBrowser
 * knows not to mark them active).
 *
 * State is exported (not just functions) because closeBrowser and
 * closeAllBrowsers need to mutate the same Set instances used by
 * trackBrowserState / markAutomationSessionInvalid.
 * Extracted from the original browserBase.js for maintainability.
 */

const { markSessionInvalid } = require("../sessionManager");

// Set of currently-open browser states; closeAllBrowsers() iterates this.
const ACTIVE_BROWSER_STATES = new Set();

// Set of platforms whose auth was marked invalid during this run; closeBrowser
// consults this to decide whether to mark the session active on close.
const INVALIDATED_PLATFORMS = new Set();

function trackBrowserState(state) {
  ACTIVE_BROWSER_STATES.add(state);
  const untrack = () => {
    state.closed = true;
    ACTIVE_BROWSER_STATES.delete(state);
  };

  if (state.context && typeof state.context.once === "function") {
    state.context.once("close", untrack);
  }
  if (state.browser && typeof state.browser.once === "function") {
    state.browser.once("disconnected", untrack);
  }

  return state;
}

function markAutomationSessionInvalid(platform) {
  INVALIDATED_PLATFORMS.add(platform);
  markSessionInvalid(platform);
}

module.exports = {
  ACTIVE_BROWSER_STATES,
  INVALIDATED_PLATFORMS,
  trackBrowserState,
  markAutomationSessionInvalid,
};

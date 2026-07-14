/**
 * backgroundJobs/state.js
 *
 * Module-level mutable state for the background-jobs worker. Holds three
 * primitives that are reassigned at runtime by other split files:
 *
 *  - campaignQueueInProgress: true while runConnectionQueueJob OR
 *    runDmQueueJob is mid-flight. Read by both queue runners as the
 *    re-entrancy guard (don't start a DM run while a connection run is
 *    active, and vice-versa) and exposed publicly via
 *    isCampaignQueueRunning() for the API that the UI polls.
 *  - currentPlatform: the platform key (lowercase) of whichever
 *    platformAdapter.runConnectionAction / runDmAction call is currently
 *    in flight. Set by the monkey-patched wrappers in
 *    platformAdapterWrappers.js, read by createProxyPage's Proxy get()
 *    handler to dispatch the standard Playwright page call to the
 *    currently-active platform's pre-launched page.
 *  - shuttingDown: latched true by gracefulShutdown() so a second SIGINT
 *    during shutdown doesn't double-fire process.exit().
 *
 * Why an object holder (not bare `let`s)? CommonJS exports snapshot the
 * value of a primitive `let` at require time — reassignment in this file
 * wouldn't propagate to a destructured `{ campaignQueueInProgress }`
 * binding in another file. By holding the primitives as PROPERTIES of a
 * shared object, every consumer that imports the `state` object reference
 * sees the latest value at property-read time (state.campaignQueueInProgress
 * is a fresh lookup every time, not a snapshot). Same pattern as Task 7's
 * executor/state.js runtimeState holder and Task 14's connectionQueue/
 * stopFlag.js (which uses functions instead of an object — both work).
 */

const state = {
  campaignQueueInProgress: false,
  currentPlatform: null,
  shuttingDown: false,
};

/**
 * Public API: is a campaign-queue run (connection OR DM) currently in
 * flight? Polled by the API to show a "busy" badge in the UI.
 */
function isCampaignQueueRunning() {
  return state.campaignQueueInProgress;
}

module.exports = {
  state,
  isCampaignQueueRunning,
};

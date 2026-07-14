/**
 * backgroundJobs/platformAdapterWrappers.js
 *
 * Monkey-patch platformAdapter.runConnectionAction and
 * platformAdapter.runDmAction so that every call updates
 * state.currentPlatform to the platform being acted upon. The
 * createProxyPage() helper then routes the standard Playwright page
 * calls (page.goto, page.click, etc.) made by processConnectionQueue /
 * processDmQueue to whichever platform's pre-launched browser page is
 * currently in flight — without the queue logic having to thread the
 * platform explicitly through every page.* call.
 *
 * installPlatformAdapterTracking() captures the original methods, replaces
 * them with wrappers that set state.currentPlatform before delegating,
 * and is idempotent (it detects the __backgroundJobsWrapped sentinel so
 * re-requiring the module doesn't double-wrap).
 *
 * Side-effect on require: installPlatformAdapterTracking() is invoked at
 * the bottom of this file so the wrappers are in place as soon as any
 * split file imports from this module (matching the original
 * backgroundJobs.js, which ran the monkey-patch at module load).
 */

const platformAdapter = require("../../campaign/platformAdapter");
const { state } = require("./state");

/**
 * Install the currentPlatform-tracking wrappers on
 * platformAdapter.runConnectionAction and .runDmAction. Idempotent.
 */
function installPlatformAdapterTracking() {
  const origConn = platformAdapter.runConnectionAction;
  const origDm = platformAdapter.runDmAction;

  // Don't double-wrap if installPlatformAdapterTracking() is somehow
  // called twice (e.g. by a hot-reload or a test that re-requires).
  if (origConn && origConn.__backgroundJobsWrapped) return;
  if (origDm && origDm.__backgroundJobsWrapped) return;

  const wrappedConn = async function (platform, page, ...args) {
    state.currentPlatform = String(platform).toLowerCase().trim();
    return origConn.call(this, platform, page, ...args);
  };
  wrappedConn.__backgroundJobsWrapped = true;

  const wrappedDm = async function (platform, page, ...args) {
    state.currentPlatform = String(platform).toLowerCase().trim();
    return origDm.call(this, platform, page, ...args);
  };
  wrappedDm.__backgroundJobsWrapped = true;

  platformAdapter.runConnectionAction = wrappedConn;
  platformAdapter.runDmAction = wrappedDm;
}

// Install on first require (matches original module-load side effect).
installPlatformAdapterTracking();

module.exports = {
  installPlatformAdapterTracking,
};

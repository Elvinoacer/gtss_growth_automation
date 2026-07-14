/**
 * cdp-manager/cdpManagerClass.js — Core CdpManager class definition.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Holds the
 * class skeleton: the constructor + the simple accessors (isRunning,
 * getState). The heavier methods (start, stop, restart, _tryAttachExisting,
 * waitForPort, openTab, openLoginTabs, checkSessions, _getCdpVersionInfo,
 * _listTargets, _getAllCookiesViaWs, ensureCdpProfile) are attached to
 * CdpManager.prototype by the sibling split files (cdpLifecycle.js,
 * cdpSessions.js, cdpProfile.js) via Object.assign / direct assignment.
 *
 * `instanceof CdpManager` is preserved because all methods end up on the
 * same prototype object regardless of which file assigned them.
 *
 * `dataRoot` is the writable per-user data directory (appData). The CDP
 * profile directory lives at `<dataRoot>/chrome-cdp-profile/` so it:
 *   - is writable on every platform (Linux .deb installs to /opt which
 *     is read-only for non-root; macOS .app bundles are read-only)
 *   - survives app updates (the user's authenticated Chrome sessions
 *     aren't wiped when they install a new version of GTSS)
 *   - matches the path the engine's bash fallback expects, because
 *     EnvBootstrap writes CDP_PROFILE_DIR=<dataRoot>/chrome-cdp-profile
 *     into the .env file and the engine reads that env var
 *     (see scripts/launch-chrome.sh and src/automation/browserBase.js).
 *
 * The `serverRoot` constructor parameter is retained for backwards
 * compatibility with unit tests but is no longer used to compute the
 * profile dir.
 */

"use strict";

const path = require("path");
const { DEFAULT_PORT, CDP_PROFILE_DIRNAME } = require("./constants");

class CdpManager {
  constructor({ dataRoot, logStream, port = DEFAULT_PORT, serverRoot = null }) {
    this.dataRoot = dataRoot;
    this.logStream = logStream;
    this.port = port;
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | stopping | crashed
    this.serverRoot = serverRoot;
    this.cdpProfileDir = path.join(dataRoot, CDP_PROFILE_DIRNAME);
    this.chromePath = null;
    this.lastError = null;
    this.startedAt = null;
    // Tracks the visibility of the Chrome we spawned (or attached to).
    //   true  — we spawned Chrome with a visible window (launcher Start / tray).
    //   false — we spawned Chrome headless (onboarding / background setup).
    //   null  — we ATTACHED to an externally-launched Chrome via
    //           _tryAttachExisting(); we don't know (and don't control)
    //           its visibility. Used by Lifecycle.startAll() to decide
    //           whether to restart Chrome visibly when the user presses
    //           Start in the launcher (headless → visible transition).
    this.startedVisible = null;
  }

  isRunning() {
    return this.state === "running";
  }

  getState() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      startedAt: this.startedAt,
      chromePath: this.chromePath,
      cdpProfileDir: this.cdpProfileDir,
      cdpEndpoint: this.isRunning() ? `http://127.0.0.1:${this.port}` : null,
      lastError: this.lastError,
    };
  }
}

module.exports = { CdpManager };

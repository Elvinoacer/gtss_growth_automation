/**
 * cdp-manager/index.js — Re-exports the public API of the original
 * desktop/main/cdp-manager.js monolith.
 *
 * The original module.exports was `{ CdpManager, validateGeminiApiKey }`
 * — this index.js preserves that EXACT surface so every caller
 * (desktop/main/main.js, desktop/main/ipc-handlers.js) continues to
 * resolve unchanged via Node.js directory-index resolution
 * (`require("./cdp-manager")` now resolves to `./cdp-manager/index.js`).
 *
 * The split files attach the heavier methods (start, stop, restart,
 * _tryAttachExisting, waitForPort, openTab, openLoginTabs, checkSessions,
 * _getCdpVersionInfo, _listTargets, _getAllCookiesViaWs, ensureCdpProfile)
 * to CdpManager.prototype. We require those split files purely for their
 * side effect of populating the prototype — by the time `index.js`
 * finishes evaluating, every method is on the prototype, so any
 * `new CdpManager(...)` instance has the full API regardless of which
 * split file assigned each method.
 *
 * File manifest:
 *   constants.js           — module-level constants (cookie signatures,
 *                            login URLs, profile-file whitelist, etc.)
 *   chromeDiscovery.js     — locateChrome / locateUserChromeProfile /
 *                            profileHasCookies
 *   profileClone.js        — atomicCopyFile / sanitizeLocalStateForSingleProfile
 *                            / cloneSessionFiles / copyDirAsync
 *   cdpManagerClass.js     — CdpManager class skeleton (constructor +
 *                            isRunning + getState)
 *   cdpLifecycle.js        — start / stop / restart / _tryAttachExisting /
 *                            waitForPort (attached to prototype)
 *   cdpSessions.js         — openTab / openLoginTabs / checkSessions /
 *                            _getCdpVersionInfo / _listTargets /
 *                            _getAllCookiesViaWs (attached to prototype)
 *   cdpProfile.js          — ensureCdpProfile (attached to prototype)
 *   geminiValidation.js    — validateGeminiApiKey
 *   index.js               — this file; re-exports CdpManager +
 *                            validateGeminiApiKey
 */

"use strict";

// Require the side-effect files first so CdpManager.prototype is fully
// populated before any consumer calls `new CdpManager(...)`.
require("./cdpLifecycle");
require("./cdpSessions");
require("./cdpProfile");

const { CdpManager } = require("./cdpManagerClass");
const { validateGeminiApiKey } = require("./geminiValidation");

module.exports = { CdpManager, validateGeminiApiKey };

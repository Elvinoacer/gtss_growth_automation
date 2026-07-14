/**
 * Browser Base — Environment & Path Helpers
 * isTruthyEnv, shouldAutoLaunchCdp, shouldAllowStandaloneBrowserLaunch,
 * envKey, getPlatformEnv, getBrowserMode, getProfileDir, normalizeHeadless —
 * pure env-driven configuration the launchers consult at runtime.
 * Extracted from the original browserBase.js for maintainability.
 */

const path = require("path");
const logger = require("../../utils/logger");

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function shouldAutoLaunchCdp() {
  return !isTruthyEnv(process.env.DISABLE_CDP_AUTO_LAUNCH);
}

function shouldAllowStandaloneBrowserLaunch() {
  return !isTruthyEnv(process.env.TEST_NO_BROWSER_LAUNCH);
}

function envKey(platform, suffix) {
  return `${platform}_${suffix}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function getPlatformEnv(platform, suffix, fallback) {
  return (
    process.env[envKey(platform, suffix)] || process.env[suffix] || fallback
  );
}

function getBrowserMode(platform, options = {}) {
  if (options.mode === "cdp") return "cdp";
  if (options.cdpEndpoint) return "cdp";
  if (getPlatformEnv(platform, "CDP_ENDPOINT")) return "cdp";

  if (options.mode === "persistent") return "persistent";
  if (options.userDataDir) return "persistent";

  const configured = getPlatformEnv(platform, "BROWSER_MODE");
  if (configured) return configured.toLowerCase();

  return "persistent";
}

function getProfileDir(platform, options = {}) {
  // Priority:
  //   1. Per-call options.userDataDir
  //   2. Per-platform USER_DATA_DIR_<PLATFORM> env var
  //   3. Global PROFILES_DIR env var (set by the desktop launcher to point
  //      at the writable userData/profiles directory)
  //   4. <cwd>/profiles/<platform> (legacy dev-mode fallback)
  //
  // The legacy fallback resolves to <serverRoot>/profiles/<platform> when
  // the server is bundled inside the desktop app — that path is READ-ONLY
  // on Linux (.deb installs to /opt) and macOS (.app bundle). The desktop
  // launcher sets PROFILES_DIR=<userData>/profiles to avoid this.
  const configured =
    options.userDataDir || getPlatformEnv(platform, "USER_DATA_DIR");
  const base =
    configured ||
    process.env.PROFILES_DIR ||
    path.join(process.cwd(), "profiles");
  return path.resolve(base, configured ? "" : platform);
}

function normalizeHeadless(platform, requestedHeadless, options = {}) {
  const { isKnownPlatform } = require("../../services/platformCatalog");

  // ─── Login sessions are ALWAYS visible ─────────────────────────────────
  if (options.loginSession === true) {
    return false;
  }

  // If the user explicitly configured CDP_VISIBLE_DEFAULT, that's their global preference
  // for automation runs (Background vs Visible).
  const visibleDefault = String(process.env.CDP_VISIBLE_DEFAULT || "").toLowerCase();

  if (visibleDefault === "true") {
    return false; // Force visible
  } else if (visibleDefault === "false") {
    return true; // Force headless (Background)
  }

  // Fallback to legacy behavior
  const userAllowsHeadless =
    options.allowHeadlessSocial === true ||
    isTruthyEnv(process.env.ALLOW_HEADLESS_SOCIAL);

  if (requestedHeadless && isKnownPlatform(platform) && !userAllowsHeadless) {
    logger.warn("BROWSER", "Headless mode disabled for social automation", {
      platform,
    });
    return false;
  }
  return requestedHeadless;
}

module.exports = {
  isTruthyEnv,
  shouldAutoLaunchCdp,
  shouldAllowStandaloneBrowserLaunch,
  envKey,
  getPlatformEnv,
  getBrowserMode,
  getProfileDir,
  normalizeHeadless,
};

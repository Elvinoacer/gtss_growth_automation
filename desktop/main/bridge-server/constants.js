/**
 * bridge-server/constants.js
 *
 * Module-level constants for the BridgeServer.
 *
 *   - DEFAULT_PORT (9224): the bridge's default listening port. The actual
 *     port may be one of [9224, 9233] if 9224 is taken (BridgeServer.start
 *     tries the next 9 ports before giving up).
 *   - PLATFORMS: the canonical list of platforms the bridge knows about.
 *     Each entry has { key, label, required, loginUrl }. This mirrors the
 *     MODAL_SESSION_PLATFORMS list in the old launcher renderer + the
 *     SESSION_COOKIE_SIGNATURES / PLATFORM_LOGIN_URLS in cdp-manager. Kept
 *     here so the bridge can answer "which platforms are required" without
 *     the web app having to duplicate the list.
 *
 * Exported via `module.exports = { DEFAULT_PORT, PLATFORMS }` and also
 * re-exported as `DEFAULT_BRIDGE_PORT` by bridge-server/index.js to
 * preserve the original module.exports surface.
 */

const DEFAULT_PORT = 9224;

const PLATFORMS = [
  { key: "google",    label: "Google / Gemini", required: true,  loginUrl: "https://gemini.google.com/" },
  { key: "linkedin",  label: "LinkedIn",        required: true,  loginUrl: "https://www.linkedin.com/" },
  { key: "facebook",  label: "Facebook",        required: false, loginUrl: "https://www.facebook.com/" },
  { key: "x",         label: "X (Twitter)",     required: false, loginUrl: "https://x.com/" },
  { key: "instagram", label: "Instagram",       required: false, loginUrl: "https://www.instagram.com/" },
];

module.exports = { DEFAULT_PORT, PLATFORMS };

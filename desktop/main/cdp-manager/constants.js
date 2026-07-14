/**
 * cdp-manager/constants.js — Module-level constants for CdpManager.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Holds:
 *   - SESSION_COOKIE_SIGNATURES  — per-platform cookie signatures used by
 *     checkSessions() to detect live login sessions
 *   - PLATFORM_LOGIN_URLS        — per-platform sign-in URLs used by
 *     openLoginTabs() during onboarding
 *   - DEFAULT_PORT               — the CDP remote-debugging port (9222)
 *   - CDP_PROFILE_DIRNAME        — name of the CDP profile dir under dataRoot
 *   - SESSION_FILES              — whitelist of small SQLite/JSON files copied
 *     from the user's real Chrome profile into the CDP profile
 *   - SESSION_FILE_MAX_BYTES     — per-file size cap for the selective clone
 *   - PROFILE_STRIP_DIRS         — heavy directories stripped from the
 *     fallback recursive copy
 *   - CLONE_CONCURRENCY          — bounded-concurrency worker count for the
 *     parallel file clone
 *
 * These constants are imported by every split file that needs them so they
 * remain a single source of truth.
 */

"use strict";

// ─── Session-detection config ───────────────────────────────────────────────
//
// Cookie names per platform. We require AT LEAST one auth cookie per platform
// to consider the session "live". These are the same cookies the platforms
// themselves use to identify an authenticated browser session, so presence of
// any one of them is a strong signal the user is logged in.
//
// Gemini (Google) is special: the copied CDP profile does NOT inherit the
// trusted-machine state for Google, so Gemini web (gemini.google.com) will
// refuse to operate until the user signs into at least one Google account
// FROM INSIDE the CDP Chrome. That's why onboarding gates completion on the
// google session being detected.
const SESSION_COOKIE_SIGNATURES = {
  google: {
    label: "Google (Gemini)",
    domains: [".google.com", "google.com", ".accounts.google.com"],
    cookies: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "LSID"],
    requiredFor: "Gemini image generation in the CDP Chrome",
  },
  linkedin: {
    label: "LinkedIn",
    domains: [".linkedin.com", "linkedin.com"],
    cookies: ["li_at", "liap", "JSESSIONID", "bscookie"],
  },
  facebook: {
    label: "Facebook",
    domains: [".facebook.com", "facebook.com"],
    cookies: ["c_user", "xs", "fr", "datr"],
  },
  x: {
    label: "X (Twitter)",
    domains: [".x.com", "x.com", ".twitter.com", "twitter.com"],
    cookies: ["auth_token", "ct0", "twid"],
  },
  instagram: {
    label: "Instagram",
    domains: [".instagram.com", "instagram.com"],
    cookies: ["sessionid", "ds_user_id", "csrftoken", "ig_did"],
  },
};

// Login URLs used by the onboarding "Sign in to your accounts" step to
// pre-open each platform's sign-in page inside the CDP Chrome. We pick the
// plain homepage for each platform so that if the user is already logged in
// (session copied from their real profile), they see their feed/homepage —
// and if not, the page itself shows a login form.
//
// Gemini is special: there is no dedicated login endpoint. Users simply
// navigate to https://gemini.google.com/ and sign in with their Google
// account from inside the CDP Chrome. The session then becomes available
// to the automation layer automatically.
const PLATFORM_LOGIN_URLS = {
  google: "https://gemini.google.com/",
  gemini: "https://gemini.google.com/",
  linkedin: "https://www.linkedin.com/",
  facebook: "https://www.facebook.com/",
  x: "https://x.com/",
  instagram: "https://www.instagram.com/",
};

const DEFAULT_PORT = 9222;
const CDP_PROFILE_DIRNAME = "chrome-cdp-profile";

// ─── Session-bearing files we copy from the user's real Chrome profile ──────
//
// Why a whitelist instead of "copy everything except caches":
// The user's `Default/` profile dir typically contains 5,000–50,000 files
// totaling 500MB–5GB. Most of that mass is in `IndexedDB/`, `Local Storage/`,
// `Sessions/`, `Media Cache/`, `Storage/`, `Service Worker/` — none of which
// are needed to preserve LinkedIn/X/Instagram/Facebook/Google logins. The
// session-bearing state lives in a handful of small SQLite/JSON files:
//
//   - Cookies                  → session cookies (the actual login tokens)
//   - Login Data               → saved passwords (encrypted via Local State + OS keyring)
//   - Login Data For Account   → account-scoped passwords
//   - Web Data                 → autofill, payment methods (small)
//   - Preferences              → JSON, profile preferences
//   - Secure Preferences       → JSON, security-managed preferences
//   - TransportSecurity        → HSTS list (small SQLite)
//   - Favicons                 → favicon cache (small SQLite, improves UX)
//   - History                  → browsing history (small SQLite, improves UX)
//   - Top Sites                → top-sites list (small SQLite)
//
// Each file is normally <8MB. Total clone drops from minutes (multi-GB)
// to under a second (a few MB). This is the fix for the "clicking Start
// hangs the app" symptom — the previous fix (CHANGES.md §3) added
// setImmediate yields every 50 files but kept `fs.copyFileSync` per file,
// which is itself blocking I/O that hangs the event loop on large files.
//
// We also copy the SQLite `-journal` / `-wal` / `-shm` sidecar files if
// they exist, so we don't leave Chrome's SQLite stores in a torn state.
// These are tiny (typically <100KB) and Chrome recreates them as needed,
// but copying them when present avoids "database is malformed" warnings.
//
// `Local State` lives at the TOP LEVEL of the user-data dir (not inside
// `Default/`) and is handled separately — see ensureCdpProfile().
const SESSION_FILES = [
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
  "Web Data",
  "Web Data-journal",
  "Preferences",
  "Secure Preferences",
  "TransportSecurity",
  "TransportSecurity-journal",
  "Favicons",
  "Favicons-journal",
  "History",
  "History-journal",
  "Top Sites",
  "Top Sites-journal",
  "Network/Cookies", // newer Chrome layouts put Cookies under Network/
  "Network/Network Persistent State",
];

// Hard cap on per-file size during the selective clone. Session/login files
// are normally <8MB; anything bigger is almost certainly a stale blob we
// don't want to copy. Defense-in-depth — if a user has somehow ended up
// with a 500MB Cookies file (impossible in practice), we skip it.
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024;

// Heavy directories we strip from the copied profile in the FALLBACK
// recursive-copy path (only used when no session files were found at the
// source — e.g., a fresh Chrome install with no logins). This list is much
// more aggressive than the previous one: it now includes IndexedDB, Local
// Storage, Sessions, Media Cache, Storage, and the full Service Worker
// tree — the actual heavy hitters that were missing before and caused the
// 10–60 second main-thread freeze.
const PROFILE_STRIP_DIRS = [
  // Caches (always safe to drop)
  "Cache",
  "CacheTmp",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphCache",
  "DawnWebGPUCache",
  "Media Cache",
  // Service Worker tree (huge; recreated on demand)
  "Service Worker",
  // IndexedDB / Storage (very huge — sites cache video blobs here)
  "IndexedDB",
  "Local Storage",
  "Session Storage",
  "Storage",
  "blob_storage",
  "File System",
  // Sessions / Sync (per-tab session state — not needed for login persistence)
  "Sessions",
  "SyncData",
  "Sync App Settings",
  // Misc heavy / unneeded
  "Downloads",
  "Crashpad",
  " component_crx_cache",
  "optimization_guide_prediction_model_downloads",
  "optimization_guide_prediction_models",
  "webrtc_event_logs",
  "SmartADCHistograms",
  "FirstPartySetsPartitioning",
  "DIPS",
  "Trust Tokens",
  "FileManager",
  "Affiliation Database",
  // Subdir under Default that some Chrome versions create
  "optimization_guide",
  "Site Characteristics Database",
];

// Concurrency limit for parallel file copies. 4 is a sweet spot: enough to
// keep the disk busy, low enough that we don't starve libuv's default
// thread pool (size 4) or thrash the page cache.
const CLONE_CONCURRENCY = 4;

module.exports = {
  SESSION_COOKIE_SIGNATURES,
  PLATFORM_LOGIN_URLS,
  DEFAULT_PORT,
  CDP_PROFILE_DIRNAME,
  SESSION_FILES,
  SESSION_FILE_MAX_BYTES,
  PROFILE_STRIP_DIRS,
  CLONE_CONCURRENCY,
};

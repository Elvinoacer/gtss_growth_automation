/**
 * cdp-manager/chromeDiscovery.js — Cross-platform Chrome binary + profile
 * discovery helpers.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Provides:
 *   - locateChrome()              — finds the user's installed Google Chrome
 *                                    binary (Win/macOS/Linux). Returns null
 *                                    when no candidate is on disk.
 *   - locateUserChromeProfile()   — finds the user's real Chrome user-data
 *                                    dir (preferred: one whose Default/ has
 *                                    a Cookies file; fallback: first
 *                                    existing candidate).
 *   - profileHasCookies()         — helper used by locateUserChromeProfile
 *                                    to detect whether a user-data dir
 *                                    carries an authenticated Default (or
 *                                    Profile N) profile.
 *
 * These are free functions used by CdpManager.start() (which calls
 * locateChrome) and CdpManager.ensureCdpProfile() (which calls
 * locateUserChromeProfile).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

function locateChrome() {
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (process.platform === "darwin") {
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
    for (const c of macPaths) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  // Linux
  const linuxBins = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
  for (const c of linuxBins) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function locateUserChromeProfile() {
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"));
    // Chrome Beta / Canary / Dev variants
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome Beta", "User Data"));
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome SxS", "User Data"));
  } else if (process.platform === "darwin") {
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome Beta"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "Chromium"));
  } else {
    // Linux
    candidates.push(path.join(os.homedir(), ".config", "google-chrome"));
    candidates.push(path.join(os.homedir(), ".config", "google-chrome-beta"));
    candidates.push(path.join(os.homedir(), ".config", "chromium"));
    candidates.push(path.join(os.homedir(), ".config", "chrome"));
    // Snap installs use ~/snap/chromium/common/chromium
    candidates.push(path.join(os.homedir(), "snap", "chromium", "common", "chromium"));
    candidates.push(path.join(os.homedir(), "snap", "google-chrome", "common", "google-chrome"));
  }

  // Prefer the first candidate that has a populated Default (or Profile N)
  // dir — i.e., one that actually contains a Cookies file. A bare config
  // dir without cookies is useless to us (the whole point of copying is to
  // inherit the user's authenticated sessions).
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (profileHasCookies(c)) return c;
  }

  // Fall back to the first existing candidate even if it has no Cookies
  // file (better than returning null — let ensureCdpProfile() warn the
  // user that no sessions were carried over).
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Returns true if the given Chrome user-data-dir has a Default (or
// Profile N) directory that contains a Cookies file. Used by
// locateUserChromeProfile() to prefer profiles that actually have
// authenticated sessions.
function profileHasCookies(userdataDir) {
  try {
    const candidates = ["Default"];
    const entries = fs.readdirSync(userdataDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && /^Profile\b/.test(e.name)) {
        candidates.push(e.name);
      }
    }
    for (const name of candidates) {
      const cookiesFile = path.join(userdataDir, name, "Cookies");
      if (fs.existsSync(cookiesFile)) return true;
    }
  } catch (_) {}
  return false;
}

module.exports = {
  locateChrome,
  locateUserChromeProfile,
  profileHasCookies,
};

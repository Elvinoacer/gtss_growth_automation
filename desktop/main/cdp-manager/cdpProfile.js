/**
 * cdp-manager/cdpProfile.js — Profile-management method for CdpManager.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Attaches
 * the `ensureCdpProfile` method to CdpManager.prototype. This is the
 * "clone if missing" half of the try-first-then-clone pattern: it checks
 * whether the CDP profile dir already has a populated Default/Cookies; if
 * so, reuses it; if not, clones from the user's real Chrome profile.
 *
 * The class skeleton lives in cdpManagerClass.js. This file imports the
 * class, attaches the method to its prototype, and re-exports it for
 * convenience — index.js requires this file for its side effect of
 * populating the prototype.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises; // async fs — used for the profile clone so we never block the Electron main thread
const path = require("path");
const { CdpManager } = require("./cdpManagerClass");
const { locateUserChromeProfile } = require("./chromeDiscovery");
const {
  SESSION_FILES,
  SESSION_FILE_MAX_BYTES,
  CLONE_CONCURRENCY,
  PROFILE_STRIP_DIRS,
} = require("./constants");
const {
  cloneSessionFiles,
  atomicCopyFile,
  sanitizeLocalStateForSingleProfile,
  copyDirAsync,
} = require("./profileClone");

// ─── Profile management ──────────────────────────────────────────────────

CdpManager.prototype.ensureCdpProfile = async function ensureCdpProfile({ onProgress } = {}) {
  // NOTE: we do NOT call this.logStream.append() here — the caller (start())
  // already wraps onProgress in a function that logs to the logStream.
  // Logging here too would double-emit every progress message.
  const progress = (stage, message) => {
    try {
      if (typeof onProgress === "function") onProgress(stage, message);
    } catch (_) {}
  };

  // ─── Harden the "already initialized" check ───────────────────────────
  // Previously we only checked `fs.existsSync(<cdpProfileDir>/Default)`.
  // That check passes for an EMPTY Default dir — which is exactly what
  // happens if a previous launch crashed mid-copy (mkdir succeeded, then
  // the copy failed before writing any files). On every subsequent
  // launch, the empty Default dir would short-circuit the copy step and
  // Chrome would start with a fresh profile containing NO authenticated
  // sessions. The user would then see "CDP Chrome has no sessions at all"
  // — the regression we are fixing.
  //
  // We now require BOTH:
  //   1. The Default dir exists, AND
  //   2. Either the Cookies file or the Login Data file exists inside it.
  // These SQLite files are what Chrome uses to persist session cookies
  // and saved logins — their presence is a strong signal the profile
  // was fully copied on a previous launch.
  const defaultProfile = path.join(this.cdpProfileDir, "Default");
  const cookiesFile = path.join(defaultProfile, "Cookies");
  const loginDataFile = path.join(defaultProfile, "Login Data");
  const profileLooksPopulated =
    fs.existsSync(defaultProfile) &&
    (fs.existsSync(cookiesFile) || fs.existsSync(loginDataFile));
  if (profileLooksPopulated) {
    // Profile already initialized on a previous launch.
    progress("init", "CDP profile already initialized — reusing existing sessions.");
    return;
  }

  // If the Default dir exists but is empty/stale, remove it so the copy
  // below starts clean. Otherwise the selective copy below would write
  // into a half-populated dir.
  if (fs.existsSync(defaultProfile) && !profileLooksPopulated) {
    progress("clone", "Existing CDP profile looks empty — re-cloning from your Chrome profile to restore sessions.");
    try {
      await fsp.rm(defaultProfile, { recursive: true, force: true });
    } catch (err) {
      this.logStream.append("cdp:stderr", `Could not remove stale profile dir: ${err.message}`);
    }
  }

  const source = locateUserChromeProfile();
  if (!source || !fs.existsSync(source)) {
    progress("init", "No existing Chrome profile found — starting with a fresh profile. You'll need to log into LinkedIn/X/Facebook/Instagram manually.");
    await fsp.mkdir(this.cdpProfileDir, { recursive: true });
    return;
  }

  // ─── Selective async atomic clone ─────────────────────────────────────
  //
  // Old behavior: `cp -r Default/` minus a small strip list. This copied
  // 5,000–50,000 files (500MB–5GB) including IndexedDB blobs, Local
  // Storage, Media Cache, Service Worker tree, etc. Even after the
  // CHANGES.md §3 fix (async + setImmediate every 50 files), each
  // individual `fs.copyFileSync` of a large file (5–50MB) blocks the
  // Electron main thread for tens-to-hundreds of ms, freezing the UI
  // ("GTSS Growth Engine is not responding" on Windows).
  //
  // New behavior: copy ONLY the small SQLite/JSON files that carry
  // session state (Cookies, Login Data, Local State, Web Data,
  // Preferences, etc.). All I/O is async (`fsp.copyFile` runs on libuv's
  // thread pool, never the main thread), each file is copied atomically
  // (write to `.tmp.<pid>` then rename — a crash mid-copy never leaves a
  // half-populated `Default/`), and copies run in parallel batches of 4
  // for speed. Total clone time drops from 10–60+ seconds to <1 second.
  progress("clone", "Cloning browser sessions from your Chrome — copying cookies and logins only...");
  progress("clone", `Source: ${source}`);
  await fsp.mkdir(this.cdpProfileDir, { recursive: true });
  await fsp.mkdir(defaultProfile, { recursive: true });

  // Determine the source profile dir name: usually "Default", but some
  // Chrome installs only have "Profile 1", "Profile 2", etc. (multi-account
  // setups). Fall back to the first "Profile *" dir we find.
  const sourceDefault = path.join(source, "Default");
  let sourceProfileDir = sourceDefault;
  let sourceProfileLabel = "Default";
  if (!fs.existsSync(sourceDefault)) {
    const profileDirs = (await fsp.readdir(source, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^Profile\b/.test(e.name))
      .map((e) => e.name);
    if (profileDirs.length > 0) {
      sourceProfileDir = path.join(source, profileDirs[0]);
      sourceProfileLabel = profileDirs[0];
      progress("clone", `Default profile not found at source; cloning ${profileDirs[0]} instead.`);
    } else {
      // No Default, no Profile N — fall back to a fresh profile.
      progress("init", "Source Chrome profile has no Default or Profile N directory — starting with a fresh profile.");
      return;
    }
  }

  // Copy the session-bearing files in parallel. Each file is copied
  // atomically (write-to-tmp + rename) so a crash mid-clone cannot
  // leave a half-written Cookies/Login Data file that would short-
  // circuit the "profileLooksPopulated" check on the next launch.
  progress("clone", `Copying session files from ${sourceProfileLabel}/...`);
  const copyResults = await cloneSessionFiles(
    sourceProfileDir,
    defaultProfile,
    SESSION_FILES,
    {
      maxBytes: SESSION_FILE_MAX_BYTES,
      concurrency: CLONE_CONCURRENCY,
      onProgress: (msg) => progress("clone", msg),
    },
  );

  // Copy "Local State" — lives at the TOP LEVEL of the source user-data
  // dir (not inside Default/), and is required to decrypt the encrypted
  // cookies/login-data on Windows and macOS (it carries the
  // `os_crypt.encrypted_key` blob, which is itself bound to the user's
  // OS keyring — copying it to the same user's machine preserves
  // decryption). Without this, copied Cookies/Login Data are useless.
  //
  // ─── Why we SANITIZE instead of copying verbatim (profile-picker fix) ──
  //
  // `Local State` also carries `profile.info_cache` — the JSON map Chrome
  // uses to populate the "Who's using Chrome?" picker. If the user's real
  // Chrome has multiple profiles (very common — e.g. a personal profile
  // plus a work one), copying this file verbatim carries ALL of those
  // profile entries into the CDP user-data-dir. Chrome then shows the
  // picker on every launch, even though we spawn with a single
  // `--user-data-dir` that only ever contains ONE actual profile
  // (`Default/`) on disk. The picker was never about an empty
  // user-data-dir (the old assumption) — it's driven by this cache
  // listing profiles that don't physically exist in the CDP profile dir.
  // The result: automation calls `chrome.newTab(openUrl)` and the
  // navigation lands on the picker interstitial instead of the target
  // URL, exactly the failure this fix addresses.
  //
  // The fix: copy the file, then rewrite `profile.info_cache` in place so
  // it lists ONLY the `Default` entry, and point the "last used" fields
  // at `Default` too. This keeps the `os_crypt` keys (and everything else
  // in the file) byte-identical — only the profile-picker-driving keys
  // are touched — so decryption of the cloned Cookies/Login Data is
  // unaffected. If parsing/rewriting fails for any reason, we fall back
  // to the verbatim copy so a malformed source file never blocks the
  // clone entirely; `--profile-directory=Default` (see start()) is the
  // second, independent layer of defense against the picker in that case.
  const localState = path.join(source, "Local State");
  if (fs.existsSync(localState)) {
    const destLocalState = path.join(this.cdpProfileDir, "Local State");
    try {
      await atomicCopyFile(localState, destLocalState, {
        maxBytes: SESSION_FILE_MAX_BYTES,
      });
      copyResults.copied.push("Local State");
      try {
        await sanitizeLocalStateForSingleProfile(destLocalState);
        copyResults.copied.push("Local State (sanitized to single profile)");
      } catch (sanitizeErr) {
        // Non-fatal: Chrome may still show the picker for this launch,
        // but --profile-directory=Default in start() covers us.
        copyResults.skipped.push({
          name: "Local State sanitize",
          reason: sanitizeErr.message,
        });
      }
    } catch (err) {
      copyResults.skipped.push({ name: "Local State", reason: err.message });
    }
  }

  // ─── Fallback: if NO session files were copied (e.g., source profile
  // is from a fresh Chrome install that has no logins yet), fall back to
  // a recursive copy of the profile dir with the (now expanded) strip
  // list. This is rare and still much smaller than before because the
  // strip list now includes IndexedDB, Local Storage, Sessions, Storage,
  // Service Worker, Media Cache — the actual heavy hitters.
  if (copyResults.copied.length === 0) {
    progress("clone", "No session files found at source — falling back to a full profile copy (caches stripped).");
    await copyDirAsync(sourceProfileDir, defaultProfile, PROFILE_STRIP_DIRS, {
      onProgress: (msg) => progress("clone", msg),
    });
  }

  // ─── Verify the copy actually produced a usable session-bearing file ──
  //
  // If neither Cookies nor Login Data exists in the destination after
  // the clone, the user's source profile is likely LOCKED (their real
  // Chrome is currently running and holding exclusive SQLite locks on
  // these files). We can't read them; the CDP Chrome will start with
  // no sessions.
  //
  // ─── Actionable UI signal (NEW) ──────────────────────────────────────
  //
  // Previously this only emitted a `cdp:stderr` log line and a generic
  // `progress("clone", "...see the warning in the logs.")` message. The
  // user had to dig through the Logs tab to find the actionable advice.
  //
  // Now we emit a dedicated `clone:warning` stage with a self-contained,
  // user-facing message. The launcher's onboarding renderer listens for
  // the `:warning` suffix and shows a first-class warning callout with a
  // "Restart Chrome" button — instead of a buried log line — so the user
  // sees: "Your Chrome is currently open — close it and click Restart
  // Chrome" right on the Finish screen.
  if (!fs.existsSync(cookiesFile) && !fs.existsSync(loginDataFile)) {
    const skippedSummary = copyResults.skipped.length > 0
      ? ` Skipped: ${copyResults.skipped.map((s) => s.name).join(", ")}.`
      : "";
    const stderrMsg =
      `Profile copy did not produce a Cookies or Login Data file.${skippedSummary} ` +
      `If Chrome is currently running, close it and click Restart Chrome so the profile (with your logins) can be copied cleanly.`;
    this.logStream.append("cdp:stderr", stderrMsg);
    // Self-contained actionable message for the UI — the renderer does
    // NOT have access to the log stream, so this string has to carry
    // the entire "what's wrong + what to do" on its own.
    const uiMsg =
      "Your Chrome is currently open and holding a lock on its session files, " +
      "so we couldn't copy your logins. Close Chrome completely, then click " +
      "\"Restart Chrome\" to retry the clone. Your existing logins will be preserved.";
    progress("clone:warning", uiMsg);
    // Also keep the informational progress line so the Logs tab still
    // shows what happened at the clone stage.
    progress("clone", "Profile copied but no sessions found — waiting for Chrome to be closed.");
  } else {
    const count = copyResults.copied.length;
    progress("clone", `Profile clone complete — ${count} session file${count === 1 ? "" : "s"} copied. Your existing logins are preserved.`);
  }
};

module.exports = { CdpManager };

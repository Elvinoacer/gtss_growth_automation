/**
 * cdp-manager/profileClone.js — Async, non-blocking helpers for cloning the
 * user's real Chrome profile into the CDP profile directory.
 *
 * Originally part of the monolithic desktop/main/cdp-manager.js. Provides:
 *   - atomicCopyFile()                       — single-file atomic clone
 *                                              (write-to-tmp + rename).
 *   - sanitizeLocalStateForSingleProfile()   — rewrite a copied Local State
 *                                              so Chrome sees exactly ONE
 *                                              profile (kills the picker).
 *   - cloneSessionFiles()                    — parallel bounded-concurrency
 *                                              copy of a whitelist of small
 *                                              session-bearing files.
 *   - copyDirAsync()                         — fallback recursive copy with
 *                                              a strip-list (used only when
 *                                              no session files exist at the
 *                                              source).
 *
 * All I/O is async (`fsp.*`), running on libuv's thread pool — never on the
 * Electron main thread. This is the fix for the historical "GTSS Growth
 * Engine is not responding" freeze on Windows during the first-launch clone
 * (the previous implementation used `fs.copyFileSync` per file).
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises; // async fs — used for the profile clone so we never block the Electron main thread
const path = require("path");

/**
 * Copy a single file atomically: write to `<dest>.tmp.<pid>` then rename.
 *
 * Why atomic: a crash (or a "GTSS is not responding" force-quit) mid-copy
 * used to leave a half-written Cookies/Login Data file. On the next launch,
 * the half-written file would satisfy the "profileLooksPopulated" check and
 * short-circuit the clone — leaving the user with NO sessions. Writing to a
 * temp file then renaming guarantees the destination is either the old
 * version (or absent) or the complete new version — never anything in
 * between.
 *
 * @param {string} src - absolute source path
 * @param {string} dest - absolute destination path
 * @param {{ maxBytes?: number }} opts - skip files larger than maxBytes
 * @returns {Promise<void>} rejects on any error (caller decides whether to skip)
 */
async function atomicCopyFile(src, dest, opts = {}) {
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : Infinity;

  // Stat the source. We use this both for the size cap and to skip if the
  // source is missing (a non-existent file is reported as a skip, not an
  // error — see cloneSessionFiles).
  const stat = await fsp.stat(src).catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!stat || !stat.isFile()) return;
  if (stat.size > maxBytes) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    throw new Error(`file too large (${mb}MB > ${(maxBytes / (1024 * 1024)).toFixed(0)}MB cap)`);
  }

  // Ensure the destination's parent dir exists (handles `Network/Cookies`
  // etc. where the parent subdir may not exist yet).
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // Write to a per-process temp file in the same dir as the destination,
  // then rename. Same-dir rename is atomic on POSIX and on Windows
  // (NTFS) — cross-dir renames are NOT atomic on Windows, which is why we
  // keep the temp file in the destination dir.
  const tmp = `${dest}.tmp.${process.pid}`;
  // Copy with COPYFILE_EXCL would fail if a stale .tmp exists from a
  // previous crashed run; we just overwrite it via the default (0) flag.
  await fsp.copyFile(src, tmp);
  // On Windows, `fsp.rename` fails with EPERM if the destination exists
  // and is held open by another process (rare, but possible if the user
  // somehow has the CDP Chrome running against the same profile during
  // the clone). Best-effort unlink-then-rename for cross-platform safety.
  try {
    await fsp.rename(tmp, dest);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EEXIST" || err.code === "ENOTEMPTY") {
      try { await fsp.unlink(dest); } catch (_) {}
      await fsp.rename(tmp, dest);
    } else {
      try { await fsp.unlink(tmp); } catch (_) {}
      throw err;
    }
  }
}

/**
 * Rewrite a copied "Local State" file in place so Chrome sees exactly ONE
 * profile ("Default") in it, instead of every profile that existed on the
 * source machine's real Chrome.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────
 * Chrome decides whether to show the "Who's using Chrome?" picker by
 * reading `profile.info_cache` out of `Local State` at startup — it does
 * NOT look at what's actually on disk under the user-data-dir. Copying
 * `Local State` verbatim from a real Chrome profile (as `ensureCdpProfile`
 * does, to preserve the `os_crypt` key needed to decrypt cloned
 * cookies/passwords) carries every one of the user's real profile entries
 * along with it. Even though the CDP user-data-dir only ever contains a
 * single `Default/` directory on disk, Chrome shows the picker for all of
 * the *stale* entries it read from `info_cache` — the exact interstitial
 * that swallows the automation's very first `openUrl` navigation.
 *
 * This function keeps the file's other top-level keys (crucially
 * `os_crypt`, which decryption depends on) completely untouched, and only
 * replaces the profile-selection keys:
 *   - `profile.info_cache`         → single "Default" entry
 *   - `profile.last_used`          → "Default"
 *   - `profile.last_active_profiles` → ["Default"]
 *   - `profile.profiles_order`     → ["Default"] (present on newer Chrome)
 *
 * @param {string} localStatePath - path to the already-copied Local State
 *   file inside the CDP profile dir (top-level, not inside Default/).
 */
async function sanitizeLocalStateForSingleProfile(localStatePath) {
  const raw = await fsp.readFile(localStatePath, "utf8");
  const state = JSON.parse(raw);

  if (!state.profile || typeof state.profile !== "object") {
    state.profile = {};
  }

  const existingDefault =
    state.profile.info_cache && state.profile.info_cache.Default;

  // Preserve the Default entry's own metadata (avatar icon, display name,
  // etc.) if the source Chrome happened to have one under this exact key;
  // otherwise fall back to a minimal entry. Either way, it's the ONLY
  // entry in the rewritten cache.
  state.profile.info_cache = {
    Default: existingDefault || { name: "Default" },
  };
  state.profile.last_used = "Default";
  state.profile.last_active_profiles = ["Default"];
  // `profiles_order` isn't present on every Chrome version — only set it
  // if the source file already had the key, to avoid introducing a field
  // that a given Chrome build doesn't expect.
  if (Array.isArray(state.profile.profiles_order)) {
    state.profile.profiles_order = ["Default"];
  }

  // Same atomic write pattern as atomicCopyFile: temp file + rename, so a
  // crash mid-write never leaves a half-written (unparseable) Local State
  // that would break decryption on the next launch.
  const tmp = `${localStatePath}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state), "utf8");
  try {
    await fsp.rename(tmp, localStatePath);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EEXIST" || err.code === "ENOTEMPTY") {
      try { await fsp.unlink(localStatePath); } catch (_) {}
      await fsp.rename(tmp, localStatePath);
    } else {
      try { await fsp.unlink(tmp); } catch (_) {}
      throw err;
    }
  }
}

/**
 * Copy a whitelist of session-bearing files from `srcDir` to `destDir`.
 *
 * Files are copied in parallel batches (`opts.concurrency`, default 4).
 * Each file is copied atomically via `atomicCopyFile`. Missing source
 * files are silently skipped (it's normal for, e.g., `Login Data For
 * Account` to be absent on profiles that never saved any passwords).
 * Files that fail to copy (locked, permission-denied, too large) are
 * recorded in the returned `skipped` array so the caller can surface a
 * useful warning to the user.
 *
 * @param {string} srcDir - source profile dir (e.g. .../Default)
 * @param {string} destDir - destination profile dir (e.g. .../chrome-cdp-profile/Default)
 * @param {string[]} files - relative file paths to copy (e.g. ["Cookies", "Login Data", "Network/Cookies"])
 * @param {{ maxBytes?: number, concurrency?: number, onProgress?: (msg: string) => void }} opts
 * @returns {Promise<{copied: string[], skipped: {name: string, reason: string}[]}>}
 */
async function cloneSessionFiles(srcDir, destDir, files, opts = {}) {
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : Infinity;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency || 4));
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const copied = [];
  const skipped = [];
  let lastReportAt = Date.now();

  // Pre-filter: stat each candidate once to drop missing files early
  // (saves a stat call inside the parallel copier and lets us show an
  // accurate "copying N of M" count up front).
  const pending = [];
  for (const name of files) {
    const src = path.join(srcDir, name);
    const exists = await fsp.stat(src).then((s) => s.isFile()).catch(() => false);
    if (exists) pending.push(name);
  }

  if (onProgress && pending.length > 0) {
    onProgress(`Copying ${pending.length} session file${pending.length === 1 ? "" : "s"} (cookies, logins, preferences)...`);
  }

  // Simple bounded-concurrency worker pool: index `i` advances as workers
  // grab the next file. Each worker copies one file at a time until the
  // queue is drained.
  let i = 0;
  async function worker() {
    while (i < pending.length) {
      const name = pending[i++];
      const src = path.join(srcDir, name);
      const dest = path.join(destDir, name);
      try {
        await atomicCopyFile(src, dest, { maxBytes });
        copied.push(name);
      } catch (err) {
        skipped.push({ name, reason: err.message || String(err) });
      }
      // Throttle progress messages to ~5/sec so we don't flood the log.
      if (onProgress && Date.now() - lastReportAt > 200) {
        lastReportAt = Date.now();
        onProgress(`Copied ${copied.length}/${pending.length} session files...`);
      }
      // Yield to the event loop between files. fsp.copyFile is non-blocking
      // already, but yielding lets any pending IPC / paint events through
      // — defense in depth for very slow disks where stat+copy can still
      // take 50–100ms per file.
      await new Promise((r) => setImmediate(r));
    }
  }
  const workers = [];
  for (let w = 0; w < concurrency && w < pending.length; w++) workers.push(worker());
  await Promise.all(workers);

  return { copied, skipped };
}

/**
 * Recursive async directory copy with a strip-list. Used ONLY as a fallback
 * when no session files were found at the source (e.g., a fresh Chrome
 * install that has never had any logins). This path is now rare and the
 * strip list (PROFILE_STRIP_DIRS) is much more aggressive than before —
 * it strips IndexedDB, Local Storage, Sessions, Storage, Service Worker,
 * Media Cache, etc., which were the actual heavy hitters causing the
 * 10–60s main-thread freeze.
 *
 * All I/O is async (`fsp.*`), with a `setImmediate` yield between files
 * to keep the Electron main thread responsive even on slow disks.
 *
 * @param {string} src - source directory
 * @param {string} dest - destination directory
 * @param {string[]} stripDirs - directory names (relative to src) to skip
 * @param {{ onProgress?: (msg: string) => void }} opts
 */
async function copyDirAsync(src, dest, stripDirs, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const state = { files: 0, dirs: 0, lastReportAt: Date.now() };
  await _copyDirAsyncInner(src, dest, stripDirs, state, onProgress);
  if (onProgress && state.files > 0) {
    onProgress(`Profile fallback copy finished — ${state.files} files in ${state.dirs} directories.`);
  }
}

async function _copyDirAsyncInner(src, dest, stripDirs, state, onProgress) {
  await fsp.mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch (err) {
    // Source dir unreadable (permission denied, etc.) — skip silently.
    return;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const relPath = path.relative(src, srcPath);
    if (stripDirs.includes(relPath) || stripDirs.includes(entry.name)) {
      continue;
    }
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        // Skip symlinks to avoid infinite loops.
        continue;
      }
      if (entry.isDirectory()) {
        state.dirs += 1;
        await _copyDirAsyncInner(srcPath, destPath, stripDirs, state, onProgress);
      } else if (entry.isFile()) {
        // Skip files > 8MB (probably media caches that slipped through
        // the strip list — defense in depth).
        const stat = await fsp.stat(srcPath);
        if (stat.size > 8 * 1024 * 1024) continue;
        await fsp.copyFile(srcPath, destPath);
        state.files += 1;
        // Report progress at most every ~250ms so we don't flood the log.
        if (onProgress && Date.now() - state.lastReportAt > 250) {
          state.lastReportAt = Date.now();
          onProgress(`Copying profile... ${state.files} files copied`);
        }
        // Yield to the event loop every ~16 files. fsp.copyFile is
        // non-blocking, but yielding keeps IPC / paint events flowing on
        // slow disks. 16 (not 50) for finer-grained responsiveness.
        if (state.files % 16 === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }
    } catch (err) {
      // Skip files we can't read (locked, permission-denied).
    }
  }
}

module.exports = {
  atomicCopyFile,
  sanitizeLocalStateForSingleProfile,
  cloneSessionFiles,
  copyDirAsync,
};

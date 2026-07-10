/**
 * AutoUpdater — wraps electron-updater with a richer, user-friendly flow.
 *
 * ─── Design goals ─────────────────────────────────────────────────────────
 *   1. Remote automatic updates — the app checks the configured provider
 *      (GitHub Releases by default) on launch and then periodically
 *      (default every 4 hours). The check is silent: it never disrupts
 *      the user.
 *   2. If a new version is available, the user is notified with a clear
 *      prompt (topbar indicator + dedicated modal with release notes).
 *      Auto-download is OFF by default (the user must consent) but can
 *      be enabled via setAutoDownload(true) — useful for unattended kiosks.
 *   3. Clear progress + status feedback throughout the process:
 *        idle → checking → available → downloading → verifying
 *              → downloaded → installing → restarting
 *      The state object exposes: status, version, releaseNotes,
 *      progress (0-100), transferredBytes, totalBytes, bytesPerSecond,
 *      etaSeconds, error, lastCheckedAt.
 *   4. Once the update is installed, the user is prompted to restart the
 *      application so the new version can take effect. quitAndInstall()
 *      is gated behind explicit user consent.
 *   5. Smooth and reliable: errors during download are surfaced (not
 *      swallowed), and the user can retry. Network failures during the
 *      periodic check are silent (logged only) so they don't spam the UI.
 *
 * ─── Configuration ────────────────────────────────────────────────────────
 *   - publish.provider=github in electron-builder.yml points to GitHub
 *     Releases. Set GH_TOKEN in CI to publish.
 *   - In dev (electron . --dev), auto-update is disabled — you can only
 *     test it from a packaged build.
 *   - The check interval is configurable via the CHECK_INTERVAL_MS
 *     constant below. Set it to 0 to disable periodic checks.
 */

const { autoUpdater } = require("electron-updater");
const { EventEmitter } = require("events");

// Periodic check interval — 4 hours. Set to 0 to disable.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Min time between manual "Check for updates" clicks, to prevent abuse.
const MIN_MANUAL_CHECK_GAP_MS = 30 * 1000;

class AutoUpdater extends EventEmitter {
  constructor({ logStream }) {
    super();
    this.log = logStream;
    this.state = {
      status: "idle", // idle | checking | available | downloading | verifying | downloaded | installing | error
      version: null,
      releaseNotes: null,
      releaseDate: null,
      progress: 0,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: 0,
      error: null,
      lastCheckedAt: null,
      autoDownload: false,
      updateInfo: null,
    };

    this._checkTimer = null;
    this._lastManualCheckAt = 0;

    if (!app_isPackaged()) {
      // Dev mode — don't talk to GitHub.
      this.log.append("updater", "Auto-updater disabled in dev mode.");
      return;
    }

    this._wireAutoUpdater();
  }

  /**
   * Wire up electron-updater's events into our state machine. Split out
   * from the constructor so the wiring is testable and readable.
   */
  _wireAutoUpdater() {
    // The user must consent before we install — we never auto-install on
    // quit because that would restart the app mid-outreach. Auto-download
    // is also OFF by default (the user clicks "Download" in the modal).
    // Use setAutoDownload(true) to enable silent downloads.
    autoUpdater.autoDownload = this.state.autoDownload;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => {
      this.setState({
        status: "checking",
        error: null,
        lastCheckedAt: Date.now(),
      });
      this.log.append("updater", "Checking for updates...");
    });

    autoUpdater.on("update-available", (info) => {
      this.setState({
        status: "available",
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate || null,
        updateInfo: info,
        progress: 0,
        transferredBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: 0,
        error: null,
      });
      this.log.append(
        "updater",
        `Update available: v${info.version}${info.releaseDate ? ` (released ${info.releaseDate})` : ""}`,
      );
      this.emit("update-available", info);
    });

    autoUpdater.on("update-not-available", (info) => {
      this.setState({
        status: "idle",
        version: info ? info.version : null,
        lastCheckedAt: Date.now(),
        error: null,
      });
      this.log.append("updater", "You're on the latest version.");
      this.emit("update-not-available", info);
    });

    autoUpdater.on("download-progress", (progress) => {
      // electron-updater gives us: percent, transferred, total,
      // bytesPerSecond. We compute ETA ourselves.
      const transferred = progress.transferred || 0;
      const total = progress.total || 0;
      const bps = progress.bytesPerSecond || 0;
      const eta = bps > 0 ? Math.max(0, Math.round((total - transferred) / bps)) : 0;
      this.setState({
        status: "downloading",
        progress: Math.round(progress.percent || 0),
        transferredBytes: transferred,
        totalBytes: total,
        bytesPerSecond: bps,
        etaSeconds: eta,
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.setState({
        status: "downloaded",
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate || null,
        progress: 100,
        transferredBytes: this.state.totalBytes,
        totalBytes: this.state.totalBytes,
        bytesPerSecond: 0,
        etaSeconds: 0,
        updateInfo: info,
      });
      this.log.append(
        "updater",
        `Update v${info.version} downloaded — ready to install. Waiting for user to confirm restart.`,
      );
      this.emit("update-downloaded", info);
    });

    autoUpdater.on("error", (err) => {
      // Don't clobber the "downloaded" state if an error happens during
      // the post-download verification step — the user can still install
      // what they've already got. Only flip to "error" if we were mid-
      // download or mid-check.
      const wasDownloaded = this.state.status === "downloaded";
      if (!wasDownloaded) {
        this.setState({ status: "error", error: err && err.message ? err.message : String(err) });
      }
      this.log.append("updater:stderr", `Update error: ${err && err.message ? err.message : err}`);
      this.emit("error", err);
    });
  }

  /**
   * Silent check — called on launch and by the periodic timer. Network
   * failures here are swallowed (logged only) so they never disrupt the
   * user.
   */
  checkSilently() {
    if (!app_isPackaged()) return;
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      this.log.append("updater:stderr", `Silent check failed: ${err.message}`);
    }
  }

  /**
   * User-initiated check — called when the user clicks "Check for updates"
   * in the About tab. Throttled to prevent abuse; throws on throttle.
   * Surfaces errors back to the caller (unlike checkSilently).
   */
  async checkForUpdates() {
    if (!app_isPackaged()) {
      throw new Error("Updates can only be checked from a packaged build.");
    }
    const now = Date.now();
    if (now - this._lastManualCheckAt < MIN_MANUAL_CHECK_GAP_MS) {
      // Throttle — don't spam GitHub.
      this.log.append("updater", "Manual check throttled (too soon after last check).");
      return;
    }
    this._lastManualCheckAt = now;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.setState({ status: "error", error: err.message });
      this.log.append("updater:stderr", `Manual check failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Download the update that was previously detected via checkSilently /
   * checkForUpdates. Resolves once the download completes — the UI is
   * driven by state changes (downloading → downloaded) in the meantime.
   */
  async downloadAndInstall() {
    if (!app_isPackaged()) {
      throw new Error("Updates can only be installed from a packaged build.");
    }
    if (this.state.status !== "available" && this.state.status !== "error") {
      // Allow re-trying from the error state — the user might have had a
      // network blip mid-download.
      throw new Error(`Cannot download from status "${this.state.status}".`);
    }
    this.log.append("updater", "Downloading update...");
    this.setState({ status: "downloading", error: null, progress: 0 });
    try {
      await autoUpdater.downloadUpdate();
      // The "update-downloaded" event will fire and update our state.
    } catch (err) {
      this.setState({ status: "error", error: err.message });
      this.log.append("updater:stderr", `Download failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Install the downloaded update and restart the app. This is the only
   * method that triggers a restart — it MUST be called from an explicit
   * user action (clicking "Install & restart" in the modal).
   *
   * isSilentRestart=false means we'll show a brief "installing" state
   * before calling quitAndInstall, so the UI can show a goodbye message.
   */
  async quitAndInstall() {
    if (this.state.status !== "downloaded") {
      throw new Error("No downloaded update to install.");
    }
    this.setState({ status: "installing" });
    this.log.append("updater", "Installing update and restarting...");
    // Give the renderer a moment to show the "restarting" state before
    // the app actually quits. 800ms is enough for one paint.
    await new Promise((r) => setTimeout(r, 800));
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Toggle auto-download. When enabled, electron-updater will start
   * downloading as soon as an update is detected — no user consent
   * needed. Useful for unattended kiosks; OFF by default for desktop use.
   */
  setAutoDownload(enabled) {
    this.state.autoDownload = !!enabled;
    if (app_isPackaged()) {
      autoUpdater.autoDownload = this.state.autoDownload;
    }
    this.emit("state-changed", this.getState());
  }

  /**
   * Start the periodic background check. Safe to call multiple times —
   * the previous timer is cleared first.
   */
  startPeriodicChecks(intervalMs = CHECK_INTERVAL_MS) {
    this.stopPeriodicChecks();
    if (!app_isPackaged() || !intervalMs || intervalMs <= 0) return;
    this._checkTimer = setInterval(() => {
      this.checkSilently();
    }, intervalMs);
    this.log.append("updater", `Periodic check every ${Math.round(intervalMs / 60000)}min started.`);
  }

  stopPeriodicChecks() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.state);
  }
}

/**
 * Release notes can be either a string (markdown/plain) or an array of
 * {version, note} objects (one per release since the running version).
 * Normalise to a single markdown string so the renderer can render it
 * uniformly.
 */
function normalizeReleaseNotes(notes) {
  if (!notes) return null;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const v = entry && entry.version ? `**v${entry.version}**\n` : "";
        const n = entry && entry.note ? String(entry.note) : "";
        return v + n;
      })
      .join("\n\n---\n\n");
  }
  if (typeof notes === "object" && notes.note) return String(notes.note);
  return null;
}

function app_isPackaged() {
  try {
    return require("electron").app.isPackaged;
  } catch (_) {
    return false;
  }
}

module.exports = { AutoUpdater, CHECK_INTERVAL_MS };

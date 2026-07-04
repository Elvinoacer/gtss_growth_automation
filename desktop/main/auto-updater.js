/**
 * AutoUpdater — wraps electron-updater.
 *
 * On launch, silently checks for a new release. If one is available, emits a
 * "update-available" event the UI can show as a toast. The user can then
 * choose to download & install via the UI; we never auto-install without
 * consent because that would restart the app mid-outreach.
 *
 * Configuration:
 *   - publish.provider=github in electron-builder.yml points to GitHub
 *     Releases. Set GH_TOKEN in CI to publish.
 *   - In dev (electron . --dev), auto-update is disabled — you can only
 *     test it from a packaged build.
 */

const { autoUpdater } = require("electron-updater");
const { EventEmitter } = require("events");

class AutoUpdater extends EventEmitter {
  constructor({ logStream }) {
    super();
    this.log = logStream;
    this.state = {
      status: "idle", // idle | checking | available | downloading | downloaded | error
      version: null,
      releaseNotes: null,
      progress: 0,
      error: null,
    };

    if (!app_isPackaged()) {
      // Dev mode — don't talk to GitHub.
      this.log.append("updater", "Auto-updater disabled in dev mode.");
      return;
    }

    autoUpdater.autoDownload = false; // ask the user first
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking" });
      this.log.append("updater", "Checking for updates...");
    });

    autoUpdater.on("update-available", (info) => {
      this.setState({
        status: "available",
        version: info.version,
        releaseNotes: info.releaseNotes,
      });
      this.log.append("updater", `Update available: v${info.version}`);
      this.emit("update-available", info);
    });

    autoUpdater.on("update-not-available", (info) => {
      this.setState({ status: "idle", version: info ? info.version : null });
      this.log.append("updater", "You're on the latest version.");
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        status: "downloading",
        progress: Math.round(progress.percent),
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.setState({ status: "downloaded", version: info.version });
      this.log.append("updater", `Update v${info.version} downloaded — will install on quit.`);
      this.emit("update-downloaded", info);
    });

    autoUpdater.on("error", (err) => {
      this.setState({ status: "error", error: err.message });
      this.log.append("updater:stderr", `Update error: ${err.message}`);
    });
  }

  checkSilently() {
    if (!app_isPackaged()) return;
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      this.log.append("updater:stderr", `Silent check failed: ${err.message}`);
    }
  }

  async downloadAndInstall() {
    if (!app_isPackaged()) {
      throw new Error("Updates can only be installed from a packaged build.");
    }
    this.log.append("updater", "Downloading update...");
    await autoUpdater.downloadUpdate();
    // The "update-downloaded" event will fire; we let the user click "Install
    // & restart" from the UI when they're ready.
  }

  quitAndInstall() {
    if (this.state.status !== "downloaded") {
      throw new Error("No downloaded update to install.");
    }
    autoUpdater.quitAndInstall(true, true);
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state-changed", this.state);
  }
}

function app_isPackaged() {
  try {
    return require("electron").app.isPackaged;
  } catch (_) {
    return false;
  }
}

module.exports = { AutoUpdater };

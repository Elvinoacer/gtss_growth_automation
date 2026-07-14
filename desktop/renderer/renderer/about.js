/**
 * renderer/about.js — About tab (version/platform info + check-updates button).
 *
 * Renders the version/platform strings into the About tab on launch, wires
 * the "Check for updates" button (which surfaces the update modal on a
 * positive result via openUpdateModal from updater.js), and wires the
 * "Open data folder" shortcut.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window */

$("#about-version").textContent = window.gtss.app.version;
$("#app-version").textContent = `v${window.gtss.app.version}`;
$("#about-platform").textContent = `${window.gtss.app.platform} (${window.gtss.app.isMac ? "macOS" : window.gtss.app.isWindows ? "Windows" : "Linux"})`;

async function loadAboutData() {
  try {
    const status = await window.gtss.lifecycle.status();
    $("#about-runtime").textContent = status.server.nodeRuntime || "—";
  } catch (_) {}
  try {
    const dataFolder = await window.gtss.open.dataFolderInfo();
    if (dataFolder) $("#about-data-folder").textContent = dataFolder;
  } catch (_) {}
}

$("#about-check-updates").addEventListener("click", async () => {
  toast("Checking for updates...", "info");
  try {
    const res = await window.gtss.updater.check();
    if (res && res.ok) {
      const s = res.state || (await window.gtss.updater.status());
      if (s.status === "available") {
        toast(`Update v${s.version} is available.`, "success");
        openUpdateModal();
      } else if (s.status === "idle") {
        toast("You're on the latest version.", "success");
      } else if (s.status === "downloaded") {
        toast(`Update v${s.version} is ready to install.`, "info");
        openUpdateModal();
      }
    } else if (res && !res.ok) {
      toast(`Couldn't check for updates: ${res.error}`, "error");
    }
  } catch (err) {
    toast(`Couldn't check for updates: ${err.message || err}`, "error");
  }
});
$("#about-open-data").addEventListener("click", () => window.gtss.open.dataFolder());

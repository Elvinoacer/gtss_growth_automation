/**
 * renderer/lifecycle.js — Start / Stop / Restart / Open / CDP / DevTools buttons.
 *
 * Click handlers for the Control tab's primary action buttons. Each handler
 * fires the matching window.gtss.lifecycle.* / window.gtss.cdp.* / window.gtss.open.*
 * bridge call, surfaces a toast for the outcome, then refreshes the status hero.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window */

$("#start-btn").addEventListener("click", async () => {
  // Clear any previous error.
  $("#error-card").classList.add("hidden");
  $("#status-hero").classList.remove("hidden");
  toast("Starting the server — the web app opens in your default browser once it's ready.", "info");
  const res = await window.gtss.lifecycle.start();
  if (res.ok) {
    toast("Ready! The web app is open in your default browser.", "success");
  } else {
    toast(`Failed to start: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#stop-btn").addEventListener("click", async () => {
  toast("Stopping server...", "info");
  const res = await window.gtss.lifecycle.stop();
  if (res.ok) {
    toast("Server stopped.", "success");
  } else {
    toast(`Failed to stop: ${res.error}`, "error");
  }
  refreshStatus();
});

$("#open-browser-btn").addEventListener("click", async () => {
  await window.gtss.openInBrowser();
});

// ─── Advanced controls ───────────────────────────────────────────────────────

$("#server-restart-btn").addEventListener("click", async () => {
  toast("Restarting server...", "info");
  const res = await window.gtss.lifecycle.restart();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});

$("#cdp-start-btn").addEventListener("click", async () => {
  toast("Starting the CDP automation browser in the background...", "info");
  const res = await window.gtss.cdp.start();
  if (res.ok) {
    toast("CDP started. Automation will use this Chrome (running in the background).", "success");
  } else {
    toast(res.error, "error");
  }
  refreshStatus();
});

$("#cdp-stop-btn").addEventListener("click", async () => {
  const res = await window.gtss.cdp.stop();
  if (!res.ok) toast(res.error, "error");
  refreshStatus();
});

$("#open-data-btn").addEventListener("click", () => window.gtss.open.dataFolder());

$("#open-devtools-btn").addEventListener("click", async () => {
  const res = await window.gtss.lifecycle.openDevtools();
  if (!res.ok) toast(`Couldn't open DevTools: ${res.error}`, "error");
});

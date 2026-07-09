/**
 * renderer.js — control-center UI logic.
 *
 * The launcher is intentionally minimal. The web app at localhost:3000 is
 * the real application — this window just starts/stops it, shows status,
 * shows logs, and surfaces friendly error cards when something goes wrong.
 *
 * Talks to the main process entirely through window.gtss.* (the preload
 * bridge). No Node access, no filesystem access, no direct IPC.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Sessions health (missing-session detection) ────────────────────────────
//
// ─── Authentication in the user's default browser (not inside Electron) ────
//
// After the server + CDP Chrome come up, we poll the CDP cookies to see
// which platforms (LinkedIn, Facebook, Instagram, Google Gemini) the
// automation browser is signed into. If any required sessions are
// missing, we surface a banner in the Control tab; clicking "Sign in…"
// opens a modal with an "Open ↗" button for each platform.
//
// IMPORTANT: The "Open ↗" buttons now open each platform's login page in
// the user's DEFAULT browser (via window.gtss.openExternal, which calls
// shell.openExternal in the main process) — NOT in the CDP Chrome that
// Electron spawned. This is the key change for "authentication in the
// browser, not inside Electron".
//
// Trade-off: because the user signs into a different browser than the
// CDP Chrome, fresh cookies set during that sign-in don't transfer to
// the automation browser automatically. The CDP profile clone (which
// runs on first launch and on "Restart CDP") is what carries cookies
// from the user's real Chrome into the CDP Chrome. So the flow is:
//
//   1. User clicks "Open ↗" on LinkedIn → LinkedIn opens in their default
//      browser (which is Chrome for most users).
//   2. User signs into LinkedIn in their default browser.
//   3. The next time the launcher starts (or the user clicks "Restart
//      CDP"), the CDP profile clone picks up the fresh LinkedIn cookies
//      from the user's real Chrome profile and copies them into the
//      CDP Chrome.
//   4. Subsequent automation runs are authenticated.
//
// We surface this clearly in the modal's intro text so the user
// understands why the green checkmark doesn't appear instantly after
// they sign in (the way it did when sign-in happened inside the CDP
// Chrome).
//
// The live polling of CDP cookies is RETAINED — it's still useful for
// detecting sessions that were ALREADY present (carried over from a
// previous clone). It just won't detect brand-new sign-ins until the
// next profile clone.

const MODAL_SESSION_PLATFORMS = [
  {
    key: "google",
    label: "Google / Gemini",
    required: true,
    icon: "G",
    loginUrl: "https://gemini.google.com/",
    loginHint: "Open Gemini and sign in with your Google account",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    required: true,
    icon: "in",
    loginUrl: "https://www.linkedin.com/",
    loginHint: "Open LinkedIn and sign in",
  },
  {
    key: "facebook",
    label: "Facebook",
    required: false,
    icon: "f",
    loginUrl: "https://www.facebook.com/",
    loginHint: "Open Facebook and sign in",
  },
  {
    key: "x",
    label: "X (Twitter)",
    required: false,
    icon: "𝕏",
    loginUrl: "https://x.com/",
    loginHint: "Open X and sign in",
  },
  {
    key: "instagram",
    label: "Instagram",
    required: false,
    icon: "IG",
    loginUrl: "https://www.instagram.com/",
    loginHint: "Open Instagram and sign in",
  },
];

let modalSessionState = {};
let modalPollTimer = null;
let modalDismissedForThisRun = false;

function renderSessionsModalGrid() {
  const grid = $("#sessions-modal-grid");
  if (!grid) return;
  grid.innerHTML = MODAL_SESSION_PLATFORMS.map((p) => {
    const state = modalSessionState[p.key] || { loggedIn: false };
    const loggedIn = Boolean(state.loggedIn);
    const cardCls = [
      "session-card",
      p.required ? "required" : "",
      loggedIn ? "logged-in" : "",
    ].filter(Boolean).join(" ");
    const stateText = loggedIn
      ? "Logged in"
      : "Not signed in yet";
    const stateCls = loggedIn ? "logged-in" : "not-logged-in";
    const check = loggedIn ? "✓" : "○";
    return `
      <div class="${cardCls}" data-session-key="${p.key}">
        <div class="session-logo ${p.key}">${p.icon}</div>
        <div class="session-info">
          <div class="session-name">
            ${p.label}
            ${p.required ? '<span class="session-required-pill">Required</span>' : ""}
          </div>
          <div class="session-state ${stateCls}">${stateText}</div>
        </div>
        <button class="btn btn-mini btn-secondary session-open-btn"
                data-platform-key="${p.key}"
                title="${p.loginHint}">
          Open ↗
        </button>
        <div class="session-check">${check}</div>
      </div>
    `;
  }).join("");

  // Wire up Open buttons — each opens the platform's login URL in the
  // user's DEFAULT browser (via window.gtss.openExternal → shell.openExternal).
  // Previously these called window.gtss.cdp.openUrlInCdp() which opened
  // the login page inside the CDP Chrome that Electron spawned. That
  // tied authentication to the Electron-controlled browser — which is
  // what we're explicitly moving away from ("authentication in the
  // browser, not inside Electron").
  //
  // The user signs in inside their normal browser. If that browser is
  // Chrome (the common case), the fresh cookies will be picked up by
  // the next CDP profile clone (run on next launcher start or on
  // "Restart CDP"). If the user's default browser is Firefox/Safari/
  // Edge, the cookies won't transfer automatically — the user would
  // need to also sign in inside Chrome for automation to work. We
  // surface this in the modal's intro text.
  grid.querySelectorAll(".session-open-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.platformKey;
      const platform = MODAL_SESSION_PLATFORMS.find((p) => p.key === key);
      if (!platform || !platform.loginUrl) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening...";
      try {
        const res = await window.gtss.openExternal(platform.loginUrl);
        if (res.ok) {
          toast(`${platform.label} opened in your default browser — sign in there.`, "info");
          // Note: we do NOT kick off an immediate poll here anymore.
          // Cookies signed into the default browser won't appear in the
          // CDP Chrome until the next profile clone. The user can click
          // "Refresh" manually after re-cloning, or just dismiss the
          // modal — the green checkmarks will populate on the next
          // launcher start.
        } else {
          toast(`Could not open ${platform.label}: ${res.error || "unknown error"}`, "error");
        }
      } finally {
        btn.textContent = original;
        const state = modalSessionState[key];
        if (!state || !state.loggedIn) btn.disabled = false;
      }
    });
  });
}

function updateSessionsModalDoneButton() {
  const btn = $("#sessions-modal-done");
  if (!btn) return;
  // Previously the "All set" button was DISABLED until every required
  // platform session was detected via CDP cookie polling. That worked
  // when sign-in happened INSIDE the CDP Chrome (cookies appeared
  // instantly). Now that sign-in happens in the user's DEFAULT browser,
  // fresh cookies don't reach the CDP Chrome until the next profile
  // clone — so gating the button on live detection would trap the user
  // in a modal they can never dismiss.
  //
  // The button is now ALWAYS enabled. The user clicks it when they've
  // finished signing in to whatever platforms they care about. The
  // green checkmarks in the grid still update from CDP polling, so any
  // sessions ALREADY present (carried over from a previous clone) will
  // show as ✓ — but the user isn't forced to wait for fresh sign-ins
  // to be detected (they won't be, until the next clone).
  btn.disabled = false;
  const requiredMissing = MODAL_SESSION_PLATFORMS.filter(
    (p) => p.required && !(modalSessionState[p.key] && modalSessionState[p.key].loggedIn),
  );
  if (requiredMissing.length === 0) {
    btn.title = "All required sessions detected";
  } else {
    btn.title =
      `Still missing in the automation browser: ${requiredMissing.map((p) => p.label).join(", ")}. ` +
      `If you just signed in to one of these in your default browser, the session will be detected after the next CDP profile clone (run "Restart CDP" or relaunch the app).`;
  }
}

function updateSessionsHealthCard() {
  const card = $("#sessions-health");
  if (!card) return;
  if (modalDismissedForThisRun) {
    card.classList.add("hidden");
    return;
  }
  const missing = MODAL_SESSION_PLATFORMS.filter(
    (p) => !(modalSessionState[p.key] && modalSessionState[p.key].loggedIn),
  );
  if (missing.length === 0) {
    card.classList.add("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "✓";
    $("#sessions-health-title").textContent = "All sessions detected";
    $("#sessions-health-meta").textContent = "LinkedIn, Facebook, Instagram, and Google Gemini are signed in.";
    $("#sessions-health-open").textContent = "View";
  } else {
    card.classList.remove("ok");
    card.classList.remove("hidden");
    $("#sessions-health-icon").textContent = "!";
    $("#sessions-health-title").textContent = "Missing browser sessions";
    const requiredMissing = missing.filter((p) => p.required);
    const label = requiredMissing.length > 0 ? requiredMissing : missing;
    $("#sessions-health-meta").textContent =
      `Sign in to: ${label.map((p) => p.label).join(", ")}. Click to open the login modal.`;
    $("#sessions-health-open").textContent = "Sign in…";
  }
}

async function pollModalSessionsOnce() {
  try {
    const res = await window.gtss.cdp.checkSessions();
    if (!res || !res.ok || !res.sessions) return;
    // Preserve previously-detected logins (avoid flicker on transient failures).
    const next = {};
    for (const p of MODAL_SESSION_PLATFORMS) {
      const fresh = res.sessions[p.key];
      const prev = modalSessionState[p.key];
      if (fresh && fresh.loggedIn) next[p.key] = fresh;
      else if (prev && prev.loggedIn) next[p.key] = prev;
      else if (fresh) next[p.key] = fresh;
    }
    modalSessionState = next;
    renderSessionsModalGrid();
    updateSessionsModalDoneButton();
    updateSessionsHealthCard();
  } catch (_) {
    // Silent — polling failures are expected.
  }
}

function startModalSessionPolling() {
  if (modalPollTimer) clearInterval(modalPollTimer);
  pollModalSessionsOnce();
  modalPollTimer = setInterval(pollModalSessionsOnce, 4000);
}

function stopModalSessionPolling() {
  if (modalPollTimer) {
    clearInterval(modalPollTimer);
    modalPollTimer = null;
  }
}

function openSessionsModal() {
  $("#sessions-modal-backdrop").classList.remove("hidden");
  $("#sessions-modal-backdrop").setAttribute("aria-hidden", "false");
  // If CDP isn't running yet, prompt the user to start the app first.
  const cdpStateEl = $("#sessions-modal-cdp-state");
  if (cdpStateEl) {
    cdpStateEl.textContent = "Chrome: checking...";
  }
  renderSessionsModalGrid();
  updateSessionsModalDoneButton();
  // Run an immediate check + start polling while the modal is open.
  pollModalSessionsOnce();
  startModalSessionPolling();
  // Also poll the CDP running state.
  window.gtss.cdp.state().then((s) => {
    if (cdpStateEl) {
      cdpStateEl.textContent = s && s.state === "running"
        ? `Chrome: running (port ${s.port})`
        : "Chrome: not running — click Start on the Control tab first.";
    }
  }).catch(() => {});
}

function closeSessionsModal() {
  $("#sessions-modal-backdrop").classList.add("hidden");
  $("#sessions-modal-backdrop").setAttribute("aria-hidden", "true");
  // Keep polling for a few more seconds so the health card stays fresh
  // after the user dismisses the modal — they may have just signed in and
  // we want the card to update. Stop after 30s to avoid leaking a timer.
  setTimeout(stopModalSessionPolling, 30000);
}

$("#sessions-health-open")?.addEventListener("click", openSessionsModal);
$("#sessions-modal-close")?.addEventListener("click", () => {
  modalDismissedForThisRun = true;
  updateSessionsHealthCard();
  closeSessionsModal();
});
$("#sessions-modal-dismiss")?.addEventListener("click", () => {
  modalDismissedForThisRun = true;
  updateSessionsHealthCard();
  closeSessionsModal();
});
$("#sessions-modal-done")?.addEventListener("click", () => {
  closeSessionsModal();
  toast("Sessions look good. You can re-open this any time from the Control tab.", "success");
});
$("#sessions-modal-refresh")?.addEventListener("click", pollModalSessionsOnce);

// When the Start button finishes launching the server + CDP Chrome, kick
// off session polling so the health card populates as soon as logins are
// detected. We hook the existing Start handler by wrapping it.
//
// ─── Auto-open the missing-sessions modal ─────────────────────────────
//
// Per project requirements: the FIRST thing that happens after the user
// clicks Start (post-onboarding) is — once the server + CDP Chrome have
// come up — we check the CDP profile for LinkedIn, X, Instagram,
// Facebook, and Google/Gemini sessions. If ANY are missing, we
// AUTOMATICALLY pop up the sign-in modal (not just the passive
// health-card banner). The modal's "Open ↗" buttons open each
// platform's login page in the user's DEFAULT browser (via
// shell.openExternal — never inside the CDP Chrome that Electron
// spawned). Live polling of CDP cookies detects sessions that were
// already present from a previous profile clone — but it won't detect
// brand-new sign-ins until the next clone runs (the user can click
// "Restart CDP" or relaunch the app to trigger a fresh clone).
const _originalStartHandler = $("#start-btn").onclick;
let _autoModalCheckAfterStart = null;
$("#start-btn").addEventListener("click", () => {
  // Reset the "dismissed" flag on a fresh Start so the banner can reappear
  // and the auto-modal can re-trigger if sessions are still missing after
  // the new launch.
  modalDismissedForThisRun = false;
  // Cancel any previous auto-modal timer (e.g., user clicked Start twice).
  if (_autoModalCheckAfterStart) {
    clearTimeout(_autoModalCheckAfterStart);
    _autoModalCheckAfterStart = null;
  }
  // Give the server + CDP ~6s to come up (the server boots first, then
  // CDP Chrome). After that we poll sessions and auto-open the modal if
  // anything required is missing.
  _autoModalCheckAfterStart = setTimeout(async () => {
    _autoModalCheckAfterStart = null;
    await pollModalSessionsOnce();
    // Auto-open the modal if any session is missing AND the user hasn't
    // dismissed it for this run. We DON'T auto-open if every required
    // platform is already signed in (e.g., the user re-ran Start after
    // completing sign-in — no need to nag them).
    const missing = MODAL_SESSION_PLATFORMS.filter(
      (p) => !(modalSessionState[p.key] && modalSessionState[p.key].loggedIn),
    );
    if (missing.length > 0 && !modalDismissedForThisRun) {
      const backdrop = $("#sessions-modal-backdrop");
      if (backdrop && backdrop.classList.contains("hidden")) {
        openSessionsModal();
        toast(
          `Missing sessions detected: ${missing.map((p) => p.label).join(", ")}. Click "Open ↗" to sign in inside your default browser.`,
          "warning",
          7000,
        );
      }
    }
    // Start a slow background poll (every 10s) that keeps the health card
    // up to date while the user is using the app, even after the modal is
    // closed. The polling is cheap (one CDP WebSocket round-trip).
    if (!modalPollTimer) {
      modalPollTimer = setInterval(pollModalSessionsOnce, 10000);
    }
  }, 6000);
});

// ─── Tabs ────────────────────────────────────────────────────────────────────

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ─── Status polling ──────────────────────────────────────────────────────────

const heroIcon = (state) => {
  const el = $("#hero-icon");
  el.classList.remove("stopped", "starting", "running", "crashed");
  el.classList.add(state);
};

function updateHero(server, cdp) {
  const state = server.state;
  heroIcon(state);

  const labels = {
    stopped: "Stopped",
    starting: "Starting...",
    running: "Running",
    stopping: "Stopping...",
    crashed: "Crashed",
  };
  $("#hero-label").textContent = labels[state] || state;

  if (state === "running") {
    const since = server.startedAt ? new Date(server.startedAt).toLocaleTimeString() : "";
    const cdpInfo = cdp.state === "running"
      ? ` · Chrome CDP on port ${cdp.port} (automation browser, background)`
      : " · CDP inactive (isolated browser mode)";
    $("#hero-meta").textContent = `Server up since ${since} · PID ${server.pid} · http://localhost:${server.port}${cdpInfo}`;
  } else if (state === "starting") {
    $("#hero-meta").textContent =
      "Booting the server... check the Logs tab for live progress. The web app opens in your default browser once the port is ready.";
  } else if (state === "stopping") {
    $("#hero-meta").textContent = "Shutting down...";
  } else if (state === "crashed") {
    $("#hero-meta").textContent = "The server crashed. See the error above.";
  } else {
    $("#hero-meta").textContent = "Click Start to launch the app in your default browser.";
  }

  // Show/hide error card.
  const errorCard = $("#error-card");
  const statusHero = $("#status-hero");
  if (state === "crashed" && server.lastDiagnostic) {
    errorCard.classList.remove("hidden");
    statusHero.classList.add("hidden");
    $("#error-title").textContent = server.lastDiagnostic.title;
    $("#error-message").textContent = server.lastDiagnostic.message;
    $("#error-remedy").textContent = server.lastDiagnostic.remedy || "";
  } else {
    errorCard.classList.add("hidden");
    statusHero.classList.remove("hidden");
  }

  // Button states.
  const isRunning = state === "running";
  const isStarting = state === "starting";
  const isStopped = state === "stopped";
  const isCrashed = state === "crashed";
  // Start is allowed when stopped OR crashed (retry from error). Disabled
  // while starting/running/stopping so the user can't kick off a second
  // boot while the first is in flight.
  $("#start-btn").disabled = !isStopped && !isCrashed;
  // Stop is allowed whenever there's something to stop — including a
  // "starting" state, so the user can cancel a slow boot instead of being
  // forced to wait for the 30s port timeout.
  $("#stop-btn").disabled = !isRunning && !isStarting;
  $("#open-browser-btn").disabled = !isRunning;
  $("#server-restart-btn").disabled = !isRunning;

  // CDP controls.
  $("#cdp-start-btn").disabled = cdp.state === "running";
  $("#cdp-stop-btn").disabled = cdp.state !== "running";

  // If CDP is running, show a small banner so the user knows.
  if (cdp.state === "running") {
    $("#hero-meta").textContent += " · CDP automation browser active (background)";
  }

  // About tab — runtime info.
  $("#about-runtime").textContent = server.nodeRuntime || "—";
}

async function refreshStatus() {
  try {
    const status = await window.gtss.lifecycle.status();
    updateHero(status.server, status.cdp);
  } catch (err) {
    console.error("Status refresh failed:", err);
  }
}

setInterval(refreshStatus, 1500);
refreshStatus();

// ─── Lifecycle buttons ───────────────────────────────────────────────────────

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

// ─── Error card actions ──────────────────────────────────────────────────────

$("#error-retry").addEventListener("click", async () => {
  $("#error-card").classList.add("hidden");
  $("#status-hero").classList.remove("hidden");
  await $("#start-btn").click();
});

$("#error-copy-logs").addEventListener("click", async () => {
  const logs = await window.gtss.logs.snapshot(200);
  const text = logs
    .map((e) => `[${e.ts}] ${e.source}: ${e.line}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Last 200 log lines copied to clipboard.", "success");
  } catch (_) {
    toast("Couldn't copy to clipboard. Open the Logs tab instead.", "error");
  }
});

// ─── Logs ────────────────────────────────────────────────────────────────────

const logsPane = $("#logs-pane");
const filters = {
  server: $("#log-filter-server"),
  cdp: $("#log-filter-cdp"),
  lifecycle: $("#log-filter-lifecycle"),
  updater: $("#log-filter-updater"),
};

let logEntries = [];

function sourceMatchesFilter(source) {
  if (source.startsWith("server")) return filters.server.checked;
  if (source.startsWith("cdp")) return filters.cdp.checked;
  if (source.startsWith("lifecycle")) return filters.lifecycle.checked;
  if (source.startsWith("updater")) return filters.updater.checked;
  return true;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderLogEntry(entry) {
  const cls = entry.source.endsWith("stderr") ? " stderr" : "";
  const sourceCls = entry.source.startsWith("lifecycle") ? " lifecycle" : "";
  const time = new Date(entry.ts).toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `log-line${cls}${sourceCls}`;
  div.innerHTML = `<span class="log-time">${time}</span>
    <span class="log-source">${escapeHtml(entry.source)}</span>
    <span class="log-text">${escapeHtml(entry.line)}</span>`;
  return div;
}

function renderLogs() {
  const visible = logEntries.filter((e) => sourceMatchesFilter(e.source));
  if (visible.length === 0) {
    logsPane.innerHTML = '<div class="logs-empty">No logs match the current filters.</div>';
    return;
  }
  logsPane.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.appendChild(renderLogEntry(e));
  logsPane.appendChild(frag);
  logsPane.scrollTop = logsPane.scrollHeight;
}

async function loadInitialLogs() {
  logEntries = await window.gtss.logs.snapshot();
  renderLogs();
}

window.gtss.logs.onLine((entry) => {
  logEntries.push(entry);
  if (logEntries.length > 5000) logEntries.shift();
  if (sourceMatchesFilter(entry.source)) {
    const empty = logsPane.querySelector(".logs-empty");
    if (empty) logsPane.innerHTML = "";
    logsPane.appendChild(renderLogEntry(entry));
    while (logsPane.children.length > 5000) {
      logsPane.removeChild(logsPane.firstChild);
    }
    logsPane.scrollTop = logsPane.scrollHeight;
  }
});

Object.values(filters).forEach((f) => f.addEventListener("change", renderLogs));
$("#logs-clear-btn").addEventListener("click", async () => {
  await window.gtss.logs.clear();
  logEntries = [];
  renderLogs();
});

// ─── About tab ───────────────────────────────────────────────────────────────

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
  await window.gtss.updater.check();
});
$("#about-open-data").addEventListener("click", () => window.gtss.open.dataFolder());

// ─── Updater ─────────────────────────────────────────────────────────────────

function updateUpdateIndicator(state) {
  const ind = $("#update-indicator");
  const label = ind.querySelector(".update-label");
  const action = $("#update-action");
  if (state.status === "available") {
    ind.classList.remove("hidden");
    label.textContent = `Update to v${state.version}`;
    action.textContent = "Download";
    action.onclick = async () => {
      action.disabled = true;
      action.textContent = "Downloading...";
      await window.gtss.updater.download();
    };
  } else if (state.status === "downloaded") {
    ind.classList.remove("hidden");
    label.textContent = `v${state.version} ready`;
    action.textContent = "Install & restart";
    action.onclick = () => window.gtss.updater.install();
  } else if (state.status === "downloading") {
    ind.classList.remove("hidden");
    label.textContent = `Downloading... ${state.progress}%`;
    action.textContent = "Downloading...";
    action.disabled = true;
  } else {
    ind.classList.add("hidden");
  }
}

window.gtss.updater.onState(updateUpdateIndicator);

// ─── Toast helper ────────────────────────────────────────────────────────────

function toast(message, kind = "info") {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ─── Init ────────────────────────────────────────────────────────────────────

loadInitialLogs();
refreshStatus();
loadAboutData();

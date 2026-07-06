/**
 * onboarding.js — first-launch wizard logic.
 *
 * Four steps:
 *   1. Set encryption passphrase (required).
 *   2. Set Gemini API key (optional — can skip).
 *   3. Sign in to your accounts (launch CDP Chrome, sign in to
 *      Google/Gemini, LinkedIn, Facebook, X). Gated on Google login
 *      because Gemini will not operate in a copied CDP profile without
 *      an active Google session — Google doesn't trust the copied
 *      profile until at least one account is signed in from inside it.
 *      The other platforms are recommended but skippable.
 *   4. Finish — main.js then auto-starts the server and opens the web app.
 *
 * Platform logins can ALSO be redone later from the web app's Settings →
 * Platform Sessions, which uses the project's existing Playwright-based
 * login flow. This onboarding step just makes sure the user lands on a
 * working setup the first time.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentStep = 1;
const totalSteps = 4;
const collected = {
  passphrase: null,
  geminiKey: null,
};

// ─── Platform definitions for the "Sign in to your accounts" step ──────────
// `required: true` means onboarding gates "Continue" on it. Google is
// required because Gemini web refuses to operate in a copied CDP profile
// until at least one Google account is signed in inside that profile.
// The social platforms are recommended but the user can skip them — they
// can complete login later from the web app's Settings → Platform Sessions.
const SESSION_PLATFORMS = [
  { key: "google",    label: "Google / Gemini", required: true,  icon: "G" },
  { key: "linkedin",  label: "LinkedIn",        required: false, icon: "in" },
  { key: "facebook",  label: "Facebook",        required: false, icon: "f" },
  { key: "x",         label: "X (Twitter)",     required: false, icon: "𝕏" },
  { key: "instagram", label: "Instagram",       required: false, icon: "IG" },
];

let sessionState = {};      // platformKey -> { loggedIn, cookies, label }
let sessionPollTimer = null;
let sessionsAutoLaunched = false;

function showStep(n) {
  currentStep = n;
  $$(".step-panel").forEach((p) => p.classList.remove("active"));
  $(`#step-${n}`).classList.add("active");
  $$(".step").forEach((s, i) => {
    s.classList.remove("active", "done");
    if (i + 1 < n) s.classList.add("done");
    else if (i + 1 === n) s.classList.add("active");
  });
}

// ─── Step 1: Passphrase ──────────────────────────────────────────────────────

$("#onboard-step1-next").addEventListener("click", () => {
  const p1 = $("#onboard-passphrase").value;
  const p2 = $("#onboard-passphrase2").value;
  if (!p1) {
    toast("Please enter a passphrase.", "error");
    return;
  }
  if (p1.length < 8) {
    toast("Passphrase must be at least 8 characters.", "error");
    return;
  }
  if (p1 !== p2) {
    toast("Passphrases don't match.", "error");
    return;
  }
  collected.passphrase = p1;
  showStep(2);
});

// ─── Step 2: Gemini API key ──────────────────────────────────────────────────

$("#onboard-open-aistudio").addEventListener("click", (e) => {
  e.preventDefault();
  // Electron's preload intercepts window.open for external links and routes
  // them to the user's default browser via shell.openExternal.
  window.open("https://aistudio.google.com/apikey", "_blank");
});

$("#onboard-skip-gemini").addEventListener("change", (e) => {
  $("#onboard-gemini-key").disabled = e.target.checked;
  if (e.target.checked) $("#onboard-gemini-key").value = "";
});

$("#onboard-step2-back").addEventListener("click", () => showStep(1));

$("#onboard-step2-next").addEventListener("click", () => {
  const skip = $("#onboard-skip-gemini").checked;
  const key = $("#onboard-gemini-key").value.trim();
  if (!skip && !key) {
    toast("Please enter your Gemini API key, or check 'I'll add this later'.", "error");
    return;
  }
  if (!skip && !key.startsWith("AIza")) {
    toast("That doesn't look like a Gemini API key (should start with 'AIza').", "warning");
    return;
  }
  collected.geminiKey = skip ? null : key;
  showStep(3);
  // Kick off the CDP Chrome + session polling automatically when the
  // user lands on step 3 — they shouldn't have to click another button
  // to get Chrome started.
  autoStartCdpForSessions();
});

// ─── Step 3: Sign in to your accounts ────────────────────────────────────────

function renderSessionsGrid() {
  const grid = $("#sessions-grid");
  if (!grid) return;
  grid.innerHTML = SESSION_PLATFORMS.map((p) => {
    const state = sessionState[p.key] || { loggedIn: false };
    const loggedIn = Boolean(state.loggedIn);
    const cardCls = [
      "session-card",
      p.required ? "required" : "",
      loggedIn ? "logged-in" : "",
    ].filter(Boolean).join(" ");
    const stateText = loggedIn
      ? `Logged in${state.cookies && state.cookies.length ? ` (${state.cookies[0]}${state.cookies.length > 1 ? ` +${state.cookies.length - 1}` : ""})` : ""}`
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
        <div class="session-check">${check}</div>
      </div>
    `;
  }).join("");
}

function updateSessionsContinueButton() {
  const btn = $("#onboard-step3-next");
  if (!btn) return;
  // Gate "Continue" on Google being logged in (required). The other
  // platforms are recommended but not strictly required — the user can
  // complete them later from Settings → Platform Sessions in the web app.
  const googleOk = Boolean(sessionState.google && sessionState.google.loggedIn);
  btn.disabled = !googleOk;
  if (googleOk) {
    btn.title = "Continue to finish setup";
  } else {
    btn.title = "Sign in to Google / Gemini in the Chrome window first — Gemini won't operate in the copied profile without an active Google login.";
  }
}

async function autoStartCdpForSessions() {
  if (sessionsAutoLaunched) return;
  sessionsAutoLaunched = true;
  await startCdpForSessions();
}

async function startCdpForSessions() {
  const stateEl = $("#sessions-cdp-state");
  const launchBtn = $("#sessions-launch-chrome");
  const reopenBtn = $("#sessions-reopen-tabs");
  const refreshBtn = $("#sessions-refresh");

  if (stateEl) {
    stateEl.textContent = "Chrome: starting…";
    stateEl.className = "sessions-cdp-state starting";
  }
  if (launchBtn) launchBtn.disabled = true;

  try {
    const res = await window.gtss.cdp.startStandalone();
    if (res && res.ok) {
      if (stateEl) {
        stateEl.textContent = "Chrome: running (CDP on port 9222)";
        stateEl.className = "sessions-cdp-state running";
      }
      if (reopenBtn) reopenBtn.disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
      if (launchBtn) {
        launchBtn.textContent = "Restart Chrome";
        launchBtn.disabled = false;
      }
      // Open login tabs (Google + the socials) so the user has a one-click
      // path to each sign-in page inside the CDP Chrome.
      await window.gtss.cdp.openLoginTabs(
        SESSION_PLATFORMS.map((p) => p.key)
      );
      startSessionPolling();
    } else {
      const msg = (res && res.error) || "Failed to start Chrome.";
      if (stateEl) {
        stateEl.textContent = `Chrome: ${msg}`;
        stateEl.className = "sessions-cdp-state error";
      }
      if (launchBtn) {
        launchBtn.textContent = "Launch Chrome";
        launchBtn.disabled = false;
      }
      toast(msg, "error");
    }
  } catch (err) {
    if (stateEl) {
      stateEl.textContent = `Chrome: ${err.message}`;
      stateEl.className = "sessions-cdp-state error";
    }
    if (launchBtn) launchBtn.disabled = false;
    toast(`Failed to start Chrome: ${err.message}`, "error");
  }
}

function startSessionPolling() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  // Poll immediately, then every 3s. The CDP cookie check is cheap (one
  // WebSocket round-trip to the running Chrome) so this doesn't burden
  // the system.
  pollSessionsOnce();
  sessionPollTimer = setInterval(pollSessionsOnce, 3000);
}

function stopSessionPolling() {
  if (sessionPollTimer) {
    clearInterval(sessionPollTimer);
    sessionPollTimer = null;
  }
}

async function pollSessionsOnce() {
  try {
    const res = await window.gtss.cdp.checkSessions();
    if (!res || !res.ok || !res.sessions) {
      // CDP query failed (Chrome closed, or websocket hiccup). Don't
      // reset existing state — just mark as "checking…".
      return;
    }
    // Only update state for platforms we know about. Preserve any
    // previously-detected login so a transient cookie read failure
    // doesn't make a green checkmark flicker off.
    const next = {};
    for (const p of SESSION_PLATFORMS) {
      const fresh = res.sessions[p.key];
      const prev = sessionState[p.key];
      if (fresh && fresh.loggedIn) {
        next[p.key] = fresh;
      } else if (prev && prev.loggedIn) {
        next[p.key] = prev;
      } else if (fresh) {
        next[p.key] = fresh;
      }
    }
    sessionState = next;
    renderSessionsGrid();
    updateSessionsContinueButton();
  } catch (_) {
    // Silent — polling failures are expected when Chrome is mid-startup
    // or when the user closes Chrome mid-onboarding.
  }
}

$("#sessions-launch-chrome")?.addEventListener("click", async () => {
  await startCdpForSessions();
});

$("#sessions-reopen-tabs")?.addEventListener("click", async () => {
  const btn = $("#sessions-reopen-tabs");
  if (btn) btn.disabled = true;
  try {
    await window.gtss.cdp.openLoginTabs(
      SESSION_PLATFORMS.map((p) => p.key)
    );
    toast("Reopened all login tabs in the Chrome window.", "info");
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("#sessions-refresh")?.addEventListener("click", async () => {
  await pollSessionsOnce();
});

$("#onboard-step3-back").addEventListener("click", () => {
  stopSessionPolling();
  showStep(2);
});

$("#onboard-step3-skip").addEventListener("click", () => {
  stopSessionPolling();
  toast(
    "Skipped platform sign-in. Complete it later in the web app's Settings → Platform Sessions — automation won't work until you do.",
    "warning",
    9000,
  );
  showStep(4);
});

$("#onboard-step3-next").addEventListener("click", () => {
  stopSessionPolling();
  // If the user signed into some but not all platforms, warn them
  // (but still allow continuing — they can finish in the web app).
  const missingRecommended = SESSION_PLATFORMS.filter((p) => !p.required && !(sessionState[p.key] && sessionState[p.key].loggedIn));
  if (missingRecommended.length > 0) {
    toast(
      `Heads up: ${missingRecommended.map((p) => p.label).join(", ")} not signed in. You can complete these later in Settings → Platform Sessions.`,
      "warning",
      8000,
    );
  }
  showStep(4);
});

// ─── Step 4: Finish ──────────────────────────────────────────────────────────

$("#onboard-finish").addEventListener("click", async () => {
  const btn = $("#onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving & starting...";
  const res = await window.gtss.onboarding.complete({
    passphrase: collected.passphrase,
    geminiKey: collected.geminiKey,
  });
  if (res.ok) {
    btn.textContent = "Done! ✓";
    btn.classList.add("btn-success");
    // main.js will close this window, open the control panel, and
    // auto-start the server. We don't need to do anything else here.
  } else {
    btn.disabled = false;
    btn.textContent = "Finish & start →";
    toast(res.error || "Failed to save onboarding data.", "error");
  }
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(message, kind = "info", durationMs = 4000) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

// Initialize the sessions grid immediately so the user sees the cards
// (all grey) the moment they navigate to step 3.
renderSessionsGrid();
updateSessionsContinueButton();

// Start at step 1.
showStep(1);

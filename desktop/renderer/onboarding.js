/**
 * onboarding.js — first-launch wizard logic.
 *
 * Four steps:
 *   1. Set encryption passphrase (required).
 *      - Live show/hide toggle on both passphrase fields.
 *      - Real-time match indicator (✅ / ❌) below the confirm field.
 *   2. Set Gemini API key (optional — can skip).
 *      - Immediate validation via window.gtss.gemini.validateKey() so the
 *        user sees ✅ "API key is valid" or ❌ "Invalid API key" before
 *        they click Continue. Quota errors (429) are treated as VALID —
 *        we only care whether the key itself is genuine.
 *   3. Sign in to your accounts (launch CDP Chrome WITHOUT cloning the
 *      profile — the slow clone is deferred to server startup so the
 *      wizard stays snappy — sign in to Google/Gemini, LinkedIn,
 *      Facebook, X, Instagram). Gated on Google login because Gemini
 *      will not operate in a copied CDP profile without an active
 *      Google session.
 *      - Live progress strip ("Initializing browser...", "Preparing CDP
 *        endpoint...", "Almost ready...") so the user always knows what
 *        the app is doing.
 *   4. Finish — main.js then auto-starts the server (with deferred
 *      browser cloning + live progress feedback) and opens the web app.
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
  geminiKeyValid: false,
};

// ─── Platform definitions for the "Sign in to your accounts" step ──────────
// `required: true` means onboarding gates "Continue" on it. Google is
// required because Gemini web refuses to operate in a copied CDP profile
// until at least one Google account is signed in inside that profile.
// The social platforms are recommended but the user can skip them — they
// can complete login later from the web app's Settings → Platform Sessions.
//
// `loginUrl` is opened inside the already-running CDP Chrome when the user
// clicks a platform card. For Gemini there is no dedicated login endpoint —
// users simply navigate to https://gemini.google.com/ and sign in normally.
const SESSION_PLATFORMS = [
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
    required: false,
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

// Wire up Show/Hide toggles for both passphrase fields.
$$(".toggle-visibility").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    if (!input) return;
    const isPwd = input.type === "password";
    input.type = isPwd ? "text" : "password";
    btn.classList.toggle("is-visible", isPwd);
    btn.setAttribute("aria-label", isPwd ? `Hide ${targetId}` : `Show ${targetId}`);
  });
});

// Live passphrase strength + match indicator. Updates in real time as the
// user types — never waits for form submission. The match badge shows:
//   - empty when either field is empty
//   - ✅ "Passphrases match"   when both fields are non-empty and equal
//   - ❌ "Passphrases don't match" when both fields are non-empty and differ
const passphraseInput = $("#onboard-passphrase");
const passphrase2Input = $("#onboard-passphrase2");
const matchIndicator = $("#passphrase-match");
const strengthIndicator = $("#passphrase-strength");

function updatePassphraseMatch() {
  const p1 = passphraseInput.value;
  const p2 = passphrase2Input.value;
  if (!p1 || !p2) {
    matchIndicator.textContent = "";
    matchIndicator.className = "match-indicator";
    return;
  }
  if (p1 === p2) {
    matchIndicator.textContent = "✅ Passphrases match";
    matchIndicator.className = "match-indicator match";
  } else {
    matchIndicator.textContent = "❌ Passphrases don't match";
    matchIndicator.className = "match-indicator mismatch";
  }
}

function updatePassphraseStrength() {
  const p = passphraseInput.value;
  if (!p) {
    strengthIndicator.textContent = "";
    strengthIndicator.className = "passphrase-strength";
    return;
  }
  // Very lightweight strength estimate — purely advisory, doesn't gate the
  // Continue button (length check below does that).
  let score = 0;
  if (p.length >= 8) score += 1;
  if (p.length >= 12) score += 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) score += 1;
  if (/\d/.test(p)) score += 1;
  if (/[^A-Za-z0-9]/.test(p)) score += 1;
  const labels = ["very weak", "weak", "fair", "good", "strong", "very strong"];
  const label = labels[Math.min(score, labels.length - 1)];
  strengthIndicator.textContent = `Strength: ${label}`;
  strengthIndicator.className = `passphrase-strength ${score >= 3 ? "match" : "mismatch"}`;
}

passphraseInput.addEventListener("input", () => {
  updatePassphraseStrength();
  updatePassphraseMatch();
});
passphrase2Input.addEventListener("input", updatePassphraseMatch);

$("#onboard-step1-next").addEventListener("click", () => {
  const p1 = passphraseInput.value;
  const p2 = passphrase2Input.value;
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

const geminiKeyInput = $("#onboard-gemini-key");
const validateKeyBtn = $("#onboard-validate-key");
const keyValidationEl = $("#gemini-key-validation");
const skipGeminiCheckbox = $("#onboard-skip-gemini");

// Enable the Validate button only when the input has a plausible-looking key.
geminiKeyInput.addEventListener("input", () => {
  const v = geminiKeyInput.value.trim();
  validateKeyBtn.disabled = v.length < 8;
  // Reset the validation badge whenever the user edits the key — the previous
  // verdict no longer applies.
  keyValidationEl.textContent = "";
  keyValidationEl.className = "key-validation";
  collected.geminiKeyValid = false;
});

skipGeminiCheckbox.addEventListener("change", (e) => {
  geminiKeyInput.disabled = e.target.checked;
  validateKeyBtn.disabled = e.target.checked || geminiKeyInput.value.trim().length < 8;
  if (e.target.checked) {
    geminiKeyInput.value = "";
    keyValidationEl.textContent = "";
    keyValidationEl.className = "key-validation";
    collected.geminiKeyValid = false;
  }
});

// Live validation: hit the Gemini list-models endpoint via the main process.
// Per requirements, quota errors (429) are treated as VALID — we only care
// whether the key itself is genuine, not whether the user has hit a rate
// limit. Network errors are shown as "couldn't reach Google" so a flaky
// connection doesn't falsely reject a good key.
async function validateGeminiKey() {
  const key = geminiKeyInput.value.trim();
  if (!key) {
    keyValidationEl.textContent = "Please enter an API key first.";
    keyValidationEl.className = "key-validation invalid";
    return;
  }
  validateKeyBtn.disabled = true;
  validateKeyBtn.textContent = "Checking...";
  keyValidationEl.textContent = "Checking key with Google...";
  keyValidationEl.className = "key-validation checking";
  try {
    const res = await window.gtss.gemini.validateKey(key);
    if (res.valid) {
      keyValidationEl.textContent = "✅ API key is valid";
      keyValidationEl.className = "key-validation valid";
      collected.geminiKeyValid = true;
    } else if (res.ok === false && !res.reason) {
      // Network error / timeout — we couldn't reach Google.
      keyValidationEl.textContent = "⚠ Couldn't reach Google to validate (check your connection).";
      keyValidationEl.className = "key-validation checking";
      collected.geminiKeyValid = false;
    } else {
      keyValidationEl.textContent = `❌ Invalid API key — ${res.reason || "Google rejected the key."}`;
      keyValidationEl.className = "key-validation invalid";
      collected.geminiKeyValid = false;
    }
  } catch (err) {
    keyValidationEl.textContent = `⚠ Validation failed: ${err.message || err}`;
    keyValidationEl.className = "key-validation checking";
    collected.geminiKeyValid = false;
  } finally {
    validateKeyBtn.disabled = skipGeminiCheckbox.checked;
    validateKeyBtn.textContent = "Validate";
  }
}

validateKeyBtn.addEventListener("click", validateGeminiKey);

// Auto-validate on blur if the key looks plausible — saves the user a click.
geminiKeyInput.addEventListener("blur", () => {
  const v = geminiKeyInput.value.trim();
  if (v && v.startsWith("AIza") && v.length >= 30 && !collected.geminiKeyValid) {
    validateGeminiKey();
  }
});

$("#onboard-step2-back").addEventListener("click", () => showStep(1));

$("#onboard-step2-next").addEventListener("click", () => {
  const skip = skipGeminiCheckbox.checked;
  const key = geminiKeyInput.value.trim();
  if (!skip && !key) {
    toast("Please enter your Gemini API key, or check 'I'll add this later'.", "error");
    return;
  }
  if (!skip && !key.startsWith("AIza")) {
    toast("That doesn't look like a Gemini API key (should start with 'AIza').", "warning");
    return;
  }
  // We DON'T strictly require a successful validation here — the user might
  // be offline, Google might be flaky, etc. But if they DID validate and
  // the key came back invalid, block progression so they don't proceed
  // with a broken key.
  if (!skip && key && collected.geminiKeyValid === false) {
    const proceed = confirm(
      "The API key failed validation. You can continue anyway and fix it later in Settings, but Gemini features won't work until you do. Continue?",
    );
    if (!proceed) return;
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
    const openBtnDisabled = loggedIn ? "disabled" : "";
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
                ${openBtnDisabled}
                title="${p.loginHint}">
          Open ↗
        </button>
        <div class="session-check">${check}</div>
      </div>
    `;
  }).join("");

  // Wire up the "Open ↗" buttons — each one opens the platform's login URL
  // inside the already-running CDP Chrome. Never spawns a new browser.
  grid.querySelectorAll(".session-open-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.platformKey;
      const platform = SESSION_PLATFORMS.find((p) => p.key === key);
      if (!platform || !platform.loginUrl) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Opening...";
      try {
        const res = await window.gtss.cdp.openUrlInCdp(platform.loginUrl);
        if (res.ok) {
          toast(`${platform.label} opened in the CDP Chrome — sign in there.`, "info");
        } else {
          toast(`Could not open ${platform.label}: ${res.error || "unknown error"}`, "error");
        }
      } finally {
        btn.textContent = original;
        // Re-enable unless the session is already logged in.
        const state = sessionState[key];
        if (!state || !state.loggedIn) btn.disabled = false;
      }
    });
  });
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

// Live progress strip for Chrome startup. The CdpManager emits progress
// messages via the logStream — but here we surface the most recent lifecycle
// log line as a friendly one-liner so the user sees continuous feedback
// instead of a frozen "Chrome: starting…" label.
const PROGRESS_STAGES = [
  { match: /Initializing browser|Using Chrome at|setup mode/i, label: "Initializing browser..." },
  { match: /Cloning browser profile|Copying profile|Profile copy/i, label: "Cloning browser profile..." },
  { match: /Preparing CDP endpoint|Launching Chrome on port/i, label: "Preparing CDP endpoint..." },
  { match: /Almost ready|CDP ready/i, label: "Almost ready..." },
];
const progressEl = $("#sessions-progress");
const progressTextEl = $("#sessions-progress-text");

function showSessionsProgress(message) {
  if (!progressEl || !progressTextEl) return;
  progressEl.hidden = false;
  let label = message;
  for (const stage of PROGRESS_STAGES) {
    if (stage.match.test(message)) {
      label = stage.label;
      break;
    }
  }
  progressTextEl.textContent = label;
}

function hideSessionsProgress() {
  if (progressEl) progressEl.hidden = true;
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
  showSessionsProgress("Initializing browser...");

  // Subscribe to live lifecycle log lines so we can update the progress
  // strip in real time. unsubscribe() is called below once Chrome is up.
  let unsubscribe = null;
  if (window.gtss && window.gtss.logs && typeof window.gtss.logs.onLine === "function") {
    unsubscribe = window.gtss.logs.onLine((entry) => {
      if (!entry) return;
      const src = entry.source || "";
      if (src.startsWith("cdp") || src.startsWith("lifecycle")) {
        showSessionsProgress(entry.line || "");
      }
    });
  }

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
      hideSessionsProgress();
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
      hideSessionsProgress();
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
    hideSessionsProgress();
    if (launchBtn) launchBtn.disabled = false;
    toast(`Failed to start Chrome: ${err.message}`, "error");
  } finally {
    if (typeof unsubscribe === "function") {
      try { unsubscribe(); } catch (_) {}
    }
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

// Live progress checklist for the deferred browser clone + server startup.
// We listen to lifecycle / cdp log lines and tick each step off as the
// corresponding message streams through.
const finishProgressEl = $("#finish-progress");
const finishSteps = {
  server: finishProgressEl?.querySelector('[data-stage="server"]'),
  init: finishProgressEl?.querySelector('[data-stage="init"]'),
  clone: finishProgressEl?.querySelector('[data-stage="clone"]'),
  endpoint: finishProgressEl?.querySelector('[data-stage="endpoint"]'),
  almostready: finishProgressEl?.querySelector('[data-stage="almost-ready"]'),
  ready: finishProgressEl?.querySelector('[data-stage="ready"]'),
};

function markFinishStepDone(stage) {
  const el = finishSteps[stage];
  if (!el) return;
  el.classList.remove("active");
  el.classList.add("done");
}

function markFinishStepActive(stage) {
  const el = finishSteps[stage];
  if (!el) return;
  el.classList.add("active");
}

function showFinishProgress() {
  if (!finishProgressEl) return;
  finishProgressEl.hidden = false;
  // Reset all steps.
  Object.values(finishSteps).forEach((el) => {
    if (el) el.classList.remove("active", "done");
  });
  markFinishStepActive("server");
}

let finishLogUnsubscribe = null;
function startFinishProgressLogListener() {
  if (!window.gtss || !window.gtss.logs) return;
  finishLogUnsubscribe = window.gtss.logs.onLine((entry) => {
    if (!entry || !entry.line) return;
    const src = entry.source || "";
    const text = entry.line;
    if (src.startsWith("lifecycle") || src.startsWith("cdp") || src.startsWith("server")) {
      if (/Server starting|Booting the Node\.js server|Server ready/i.test(text)) {
        if (/Server ready/i.test(text)) markFinishStepDone("server");
        else markFinishStepActive("server");
      }
      if (/Initializing browser|Using Chrome at|setup mode/i.test(text)) {
        markFinishStepDone("server");
        markFinishStepActive("init");
      }
      if (/Cloning browser profile|Copying profile|Profile copy/i.test(text)) {
        markFinishStepDone("init");
        markFinishStepActive("clone");
      }
      if (/Preparing CDP endpoint|Launching Chrome on port/i.test(text)) {
        markFinishStepDone("clone");
        markFinishStepDone("init");
        markFinishStepActive("endpoint");
      }
      if (/Almost ready/i.test(text)) {
        markFinishStepDone("endpoint");
        markFinishStepActive("almostready");
      }
      if (/CDP ready|Browser ready|Ready\./i.test(text)) {
        markFinishStepDone("endpoint");
        markFinishStepDone("almostready");
        markFinishStepActive("ready");
      }
    }
  });
}

function stopFinishProgressLogListener() {
  if (typeof finishLogUnsubscribe === "function") {
    try { finishLogUnsubscribe(); } catch (_) {}
    finishLogUnsubscribe = null;
  }
}

$("#onboard-finish").addEventListener("click", async () => {
  const btn = $("#onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving & starting...";
  showFinishProgress();
  startFinishProgressLogListener();
  const res = await window.gtss.onboarding.complete({
    passphrase: collected.passphrase,
    geminiKey: collected.geminiKey,
  });
  if (res.ok) {
    btn.textContent = "Done! ✓";
    btn.classList.add("btn-success");
    // main.js will close this window, open the control panel, and
    // auto-start the server. The progress checklist above stays visible
    // (and continues updating from log lines) until the window is closed.
    // We keep the listener attached so the user sees the deferred browser
    // clone + server startup progress right up until the launcher UI takes
    // over.
    setTimeout(() => stopFinishProgressLogListener(), 30000);
  } else {
    btn.disabled = false;
    btn.textContent = "Finish & start →";
    if (finishProgressEl) finishProgressEl.hidden = true;
    stopFinishProgressLogListener();
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

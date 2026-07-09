/**
 * onboarding.js — first-launch wizard logic.
 *
 * Three steps (was four — platform sign-in was removed from the wizard):
 *   1. Set encryption passphrase (required).
 *      - Live show/hide toggle on both passphrase fields.
 *      - Real-time match indicator (✅ / ❌) below the confirm field.
 *   2. Set Gemini API key (optional — can skip).
 *      - Immediate validation via window.gtss.gemini.validateKey() so the
 *        user sees ✅ "API key is valid" or ❌ "Invalid API key" before
 *        they click Continue. Quota errors (429) are treated as VALID —
 *        we only care whether the key itself is genuine.
 *   3. Finish — main.js then auto-starts the server (with the deferred
 *      browser clone + live progress feedback) and opens the web app.
 *
 * ─── Where did platform sign-in go? ─────────────────────────────────────
 *
 * Previously step 3 ("Sign in to your accounts") launched CDP Chrome
 * during setup so the user could sign in to Google/Gemini, LinkedIn,
 * Facebook, X, and Instagram. That caused problems:
 *
 *   - It launched Chrome during SETUP, which fails when the user has no
 *     Chrome profile yet (or the profile is locked because their real
 *     Chrome is open) and confuses first-time users.
 *   - It duplicated the session-management UX that already lives in the
 *     web app's Settings → Platform Sessions.
 *   - It violated the project's "Chrome is launched ONCE, in the launch
 *     phase, never in setup" rule.
 *
 * Now platform sign-in happens AFTER the user clicks Finish: the launcher
 * starts the server, opens the web app in the CDP Chrome, and the
 * launcher window automatically pops up a "missing sessions" modal if any
 * of LinkedIn / X / Instagram / Facebook / Google(Gemini) aren't signed
 * in. The modal's "Open ↗" buttons open each platform's login page IN
 * that same CDP Chrome, and live polling detects each login. See
 * desktop/renderer/renderer.js for the modal logic.
 *
 * The web app's Settings → Platform Sessions still works as before for
 * re-authenticating or clearing individual platform sessions later.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentStep = 1;
const totalSteps = 3;
const collected = {
  passphrase: null,
  geminiKey: null,
  geminiKeyValid: false,
};

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
});

// ─── Step 3: Finish ──────────────────────────────────────────────────────────

// ─── Live progress checklist for the server + browser startup ───────────────
//
// Previously this used a regex-based log scraper — it listened to
// lifecycle/cdp log lines and pattern-matched phrases like "Server ready"
// to tick steps off. That was fragile (any wording change broke it) and
// didn't surface errors.
//
// Now we subscribe to the structured "onboarding:progress" IPC channel.
// Each event is { stage, message, ts } where `stage` is a stable
// identifier emitted by Lifecycle.startAll(). We map stages to UI steps:
//
//   "start"        → (initial banner, no step change)
//   "server"       → step "server" active
//   "server:error" → step "server" error
//   "browser"      → step "browser" active (also covers init/endpoint/
//                    almost-ready, which Lifecycle maps to "browser")
//   "browser:error"→ step "browser" error
//   "clone"        → step "clone" active
//   "endpoint"     → step "endpoint" active
//   "open-webapp"  → step "open-webapp" active
//   "open-webapp:error" → step "open-webapp" error
//   "ready"        → all steps done
//
// The stage order matches the visual order of the steps in the HTML.
// When a later stage arrives, all earlier stages are marked done (so a
// skipped stage — e.g., "clone" when attaching to an existing Chrome —
// still shows a green checkmark).
const STAGE_ORDER = ["server", "browser", "clone", "endpoint", "open-webapp", "ready"];

const finishProgressEl = $("#finish-progress");
const finishErrorEl = $("#finish-progress-error");
const finishStepEls = {};
STAGE_ORDER.forEach((key) => {
  finishStepEls[key] = finishProgressEl?.querySelector(`[data-stage="${key}"]`);
});

function showFinishProgress() {
  if (!finishProgressEl) return;
  finishProgressEl.hidden = false;
  // Reset all steps to pending.
  STAGE_ORDER.forEach((key) => {
    const el = finishStepEls[key];
    if (!el) return;
    el.classList.remove("active", "done", "error");
  });
  if (finishErrorEl) {
    finishErrorEl.hidden = true;
    finishErrorEl.textContent = "";
  }
  // Reset the warning callout too (NEW). A previous run may have left
  // it visible after a clone:warning; when the user clicks Restart
  // Chrome (or Finish & start again), we want a clean slate.
  const warningCallout = $("#finish-progress-warning");
  if (warningCallout) {
    warningCallout.hidden = true;
    const msgEl = warningCallout.querySelector(".finish-warning-message");
    if (msgEl) msgEl.textContent = "";
    delete warningCallout.dataset.stage;
  }
}

function markFinishStageActive(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return;
  // Mark all earlier stages as done (they must have completed for us to
  // reach this stage). This handles skipped stages (e.g., "clone" is
  // skipped when we attach to an existing Chrome) gracefully.
  for (let i = 0; i < idx; i++) {
    const el = finishStepEls[STAGE_ORDER[i]];
    if (el) {
      el.classList.remove("active", "error");
      el.classList.add("done");
    }
  }
  const el = finishStepEls[stage];
  if (el) {
    el.classList.remove("done", "error");
    el.classList.add("active");
  }
}

function markFinishStageDone(stage) {
  const el = finishStepEls[stage];
  if (!el) return;
  el.classList.remove("active", "error");
  el.classList.add("done");
}

function markFinishStageError(stage, message) {
  // If the stage isn't one of our tracked steps, fall back to "server"
  // so the error is at least visible somewhere.
  const key = STAGE_ORDER.includes(stage) ? stage : "server";
  const el = finishStepEls[key];
  if (el) {
    el.classList.remove("active", "done");
    el.classList.add("error");
  }
  if (finishErrorEl && message) {
    finishErrorEl.hidden = false;
    finishErrorEl.textContent = message;
  }
}

// ─── Warning callout (NEW) ─────────────────────────────────────────────────
//
// Distinct from `markFinishStageError`: a warning is a non-fatal but
// actionable condition. The step is still considered "done" (we did
// finish cloning — we just didn't get any sessions out of it) but the
// user needs to do something (close Chrome and click Restart). The
// warning callout shows the message + a Restart Chrome button so the
// user can re-trigger the clone without restarting the whole app.
//
// Used for:
//   - "clone:warning" — Chrome is locked, profile copy produced no sessions
//   - "browser:warning" — fell back to isolated-browser mode (no cloned
//     sessions will be available; the user will need to sign in manually)
function markFinishStageWarning(stage, message) {
  // Keep the step visually "done" (the clone did run, the browser did
  // come up) — but show a yellow callout with the actionable message.
  const key = STAGE_ORDER.includes(stage) ? stage : null;
  if (key) {
    markFinishStageDone(key);
  }
  const callout = $("#finish-progress-warning");
  if (callout && message) {
    callout.hidden = false;
    const msgEl = callout.querySelector(".finish-warning-message");
    if (msgEl) msgEl.textContent = message;
    // Stash the stage on the callout so the Restart button knows which
    // recovery action to invoke.
    callout.dataset.stage = stage || "";
  }
}

function markAllFinishStagesDone() {
  STAGE_ORDER.forEach((key) => markFinishStageDone(key));
}

let progressUnsubscribe = null;

function startFinishProgressListener() {
  if (!window.gtss || !window.gtss.onboarding || !window.gtss.onboarding.onProgress) return;
  progressUnsubscribe = window.gtss.onboarding.onProgress(({ stage, message }) => {
    if (!stage) return;
    // Error stages are suffixed with ":error".
    if (stage.endsWith(":error")) {
      const baseStage = stage.slice(0, -":error".length);
      markFinishStageError(baseStage, message);
      return;
    }
    // Warning stages are suffixed with ":warning" (NEW).
    // These are non-fatal but actionable: we keep the step visually
    // "done" and surface a yellow callout with a Restart button so the
    // user can recover without re-running the whole wizard.
    if (stage.endsWith(":warning")) {
      const baseStage = stage.slice(0, -":warning".length);
      markFinishStageWarning(baseStage, message);
      return;
    }
    if (stage === "ready") {
      // Everything done.
      markAllFinishStagesDone();
      return;
    }
    if (STAGE_ORDER.includes(stage)) {
      markFinishStageActive(stage);
    }
    // "start" is just an initial banner — no step change.
  });
}

function stopFinishProgressListener() {
  if (typeof progressUnsubscribe === "function") {
    try { progressUnsubscribe(); } catch (_) {}
    progressUnsubscribe = null;
  }
}

$("#onboard-finish").addEventListener("click", async () => {
  const btn = $("#onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving & starting...";
  showFinishProgress();
  // Subscribe BEFORE calling complete() so we don't miss the early
  // stages (server / browser init can fire within milliseconds).
  startFinishProgressListener();
  const res = await window.gtss.onboarding.complete({
    passphrase: collected.passphrase,
    geminiKey: collected.geminiKey,
  });
  if (res && res.ok) {
    // main.js will close this window and open the control panel.
    // The progress checklist stays visible (showing all-green ✓) until
    // the window is destroyed. We keep the listener attached so any
    // final "ready" event arrives cleanly.
    btn.textContent = "Done! ✓";
    btn.classList.add("btn-success");
    // Defensive: stop the listener after 30s in case the window swap
    // is delayed for some reason.
    setTimeout(() => stopFinishProgressListener(), 30000);
  } else {
    // Startup failed — keep the onboarding window open so the user can
    // see the error and retry. The failing step already shows a red ✗
    // via markFinishStageError(); we also surface the error message in
    // the dedicated error element under the checklist.
    btn.disabled = false;
    btn.textContent = "Finish & start →";
    if (finishErrorEl) {
      finishErrorEl.hidden = false;
      finishErrorEl.textContent = res?.error || "Failed to start the server. Click Finish & start to retry.";
    }
    stopFinishProgressListener();
    toast(res?.error || "Failed to save onboarding data.", "error");
  }
});

// ─── Restart Chrome button (NEW) ─────────────────────────────────────────────
//
// The warning callout (clone:warning / browser:warning) surfaces a
// "Restart Chrome" button so the user can recover from a locked-Chrome
// condition without re-running the entire wizard. Clicking it:
//   1. Hides the warning callout.
//   2. Re-runs the CDP restart path (which closes the spawned Chrome,
//      re-runs the profile clone, and re-spawns Chrome).
//   3. Re-subscribes to the progress stream so the checklist updates
//      as the restart progresses.
//
// If window.gtss.cdp.restart isn't available (older main process),
// we fall back to telling the user to click "Finish & start" again.
$("#finish-warning-restart")?.addEventListener("click", async () => {
  const restartBtn = $("#finish-warning-restart");
  if (!restartBtn) return;
  const original = restartBtn.textContent;
  restartBtn.disabled = true;
  restartBtn.textContent = "Restarting Chrome...";
  const callout = $("#finish-progress-warning");
  // Hide the callout immediately so the user sees their click registered.
  if (callout) callout.hidden = true;
  // Re-show the progress checklist in its "in progress" state.
  showFinishProgress();
  startFinishProgressListener();
  try {
    if (window.gtss && window.gtss.cdp && typeof window.gtss.cdp.restart === "function") {
      const res = await window.gtss.cdp.restart();
      if (!res || !res.ok) {
        toast(res?.error || "Couldn't restart Chrome automatically. Close Chrome manually and click Finish & start again.", "warning", 7000);
      }
    } else {
      toast("Restart Chrome isn't available in this build. Close Chrome manually and click Finish & start again.", "warning", 7000);
    }
  } catch (err) {
    toast(`Failed to restart Chrome: ${err.message || err}`, "error");
  } finally {
    restartBtn.disabled = false;
    restartBtn.textContent = original;
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

// Start at step 1.
showStep(1);

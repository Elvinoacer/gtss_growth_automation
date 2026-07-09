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
      // If we attached to an existing Chrome, skip the clone stage entirely.
      if (/Reusing existing Chrome/i.test(text)) {
        markFinishStepDone("server");
        markFinishStepDone("init");
        markFinishStepDone("clone");
        markFinishStepDone("endpoint");
        markFinishStepActive("ready");
        return;
      }
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

// Start at step 1.
showStep(1);

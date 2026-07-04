/**
 * onboarding.js — first-launch wizard logic.
 *
 * Three steps:
 *   1. Set encryption passphrase (required).
 *   2. Set Gemini API key (optional — can skip).
 *   3. Finish — main.js then auto-starts the server and opens the web app.
 *
 * Platform logins (LinkedIn/X/Facebook/Instagram) are intentionally NOT here.
 * They happen in the web app's Settings → Platform Sessions, which uses the
 * project's existing Playwright-based login flow.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentStep = 1;
const totalSteps = 3;
const collected = {
  passphrase: null,
  geminiKey: null,
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
});

// ─── Step 3: Finish ──────────────────────────────────────────────────────────

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

function toast(message, kind = "info") {
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
  }, 4000);
}

// Start at step 1.
showStep(1);

/**
 * onboarding.js — first-launch wizard logic.
 * Talks to the main process via window.gtss.onboarding.*.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentStep = 1;
const totalSteps = 4;
const collected = {
  passphrase: null,
  geminiKey: null,
  platforms: new Set(),
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
  // The preload intercepts window.open for external links.
  window.open("https://aistudio.google.com/apikey", "_blank");
});

$("#onboard-skip-gemini").addEventListener("change", (e) => {
  $("#onboard-gemini-key").disabled = e.target.checked;
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

// ─── Step 3: Platform logins ────────────────────────────────────────────────

$$(".platform-login-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const card = btn.closest(".platform-card");
    const platform = card.dataset.platform;
    const status = card.querySelector(".platform-status");
    btn.disabled = true;
    btn.textContent = "Opening...";
    const res = await window.gtss.onboarding.openLogin(platform);
    btn.disabled = false;
    btn.textContent = "Log in";
    if (res.ok) {
      status.textContent = "Opened in browser — log in there";
      status.classList.add("logged-in");
      collected.platforms.add(platform);
      btn.textContent = "Reopen";
    } else {
      toast(res.error || "Failed to open login page", "error");
    }
  });
});

$("#onboard-step3-back").addEventListener("click", () => showStep(2));
$("#onboard-step3-next").addEventListener("click", () => {
  // Update summary.
  $("#summary-platforms").textContent = collected.platforms.size > 0
    ? `✓ Logged in: ${[...collected.platforms].join(", ")}`
    : "Platform logins: skipped (you can do this later)";
  showStep(4);
});

// ─── Step 4: Finish ──────────────────────────────────────────────────────────

$("#onboard-finish").addEventListener("click", async () => {
  const btn = $("#onboard-finish");
  btn.disabled = true;
  btn.textContent = "Saving...";
  const res = await window.gtss.onboarding.complete({
    passphrase: collected.passphrase,
    geminiKey: collected.geminiKey,
  });
  if (res.ok) {
    btn.textContent = "Done! ✓";
    // The main process will swap windows.
  } else {
    btn.disabled = false;
    btn.textContent = "Finish →";
    toast(res.error || "Failed to save onboarding data.", "error");
  }
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(message, kind = "info") {
  const container = document.getElementById("toast-container") || (() => {
    const c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
    return c;
  })();
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

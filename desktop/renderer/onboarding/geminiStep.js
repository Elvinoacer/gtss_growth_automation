/**
 * onboarding/geminiStep.js — Step 2: Gemini API key (optional).
 *
 * Wires the open-AI-Studio link, the live Validate button, the Skip
 * checkbox, the auto-validate-on-blur convenience, and the Back /
 * Continue buttons for Step 2.
 *
 * Top-level statements that run at script-load time:
 *   - $("#onboard-open-aistudio").addEventListener(...) — opens
 *     https://aistudio.google.com/apikey in the user's default browser
 *     via Electron's shell.openExternal (intercepted by preload's
 *     window.open override).
 *   - geminiKeyInput / validateKeyBtn / keyValidationEl /
 *     skipGeminiCheckbox const declarations (cached DOM refs).
 *   - geminiKeyInput.addEventListener("input", ...) — enables the
 *     Validate button when the input has a plausible-looking key
 *     (≥8 chars) and resets the validation badge.
 *   - skipGeminiCheckbox.addEventListener("change", ...) — disables
 *     the input + Validate button when the skip box is checked, clears
 *     the input, resets the validation badge.
 *   - validateKeyBtn.addEventListener("click", validateGeminiKey)
 *   - geminiKeyInput.addEventListener("blur", ...) — auto-validates on
 *     blur if the key starts with "AIza" and is ≥30 chars and hasn't
 *     been validated yet (saves the user a click).
 *   - $("#onboard-step2-back").addEventListener(...) → showStep(1)
 *   - $("#onboard-step2-next").addEventListener(...) — validates that
 *     either Skip is checked or a key is entered, warns if the key
 *     doesn't start with "AIza", and if validation failed earlier
 *     prompts with confirm() to proceed anyway. On success stashes the
 *     key (or null) into collected and calls showStep(3).
 *
 * Cross-file dependencies (call-time only): $ (state.js), collected
 * (state.js — mutated), showStep (stepNavigation.js), toast (toast.js),
 * window.gtss.gemini.validateKey (provided by the Electron preload
 * bridge).
 */

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

/**
 * onboarding/passphraseStep.js — Step 1: set the encryption passphrase.
 *
 * Wires the Show/Hide toggles for both passphrase fields + the live
 * passphrase strength + match indicator, and validates on Continue.
 *
 * Top-level statements that run at script-load time:
 *   - $$(".toggle-visibility").forEach(...) — wires the Show/Hide
 *     password toggle on every .toggle-visibility button (Step 1 has
 *     two: passphrase + confirm). Toggling flips input.type between
 *     "password" and "text" and updates the aria-label.
 *   - passphraseInput / passphrase2Input / matchIndicator /
 *     strengthIndicator const declarations (cached DOM refs).
 *   - passphraseInput.addEventListener("input", ...) — re-runs the
 *     strength + match indicators on every keystroke.
 *   - passphrase2Input.addEventListener("input", updatePassphraseMatch)
 *     — re-runs the match indicator on every keystroke in the confirm
 *     field.
 *   - $("#onboard-step1-next").addEventListener("click", ...) —
 *     validates passphrase is non-empty, ≥8 chars, and matches the
 *     confirm field; on success stashes passphrase into collected and
 *     calls showStep(2).
 *
 * Cross-file dependencies (call-time only): $ / $$ (state.js),
 * collected (state.js — mutated), showStep (stepNavigation.js),
 * toast (toast.js).
 */

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

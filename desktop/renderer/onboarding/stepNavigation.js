/**
 * onboarding/stepNavigation.js — Step-panel visibility + stepper dots.
 *
 * showStep(n) — switches the wizard to step `n` (1-based):
 *   - Hides every .step-panel, then activates #step-n
 *   - Updates every .step indicator: steps before n → "done" (green
 *     check), step n → "active" (current), steps after n → idle
 *   - Updates the module-private currentStep let (in state.js) so
 *     later code knows which step the user is on
 *
 * Called from init.js at boot with showStep(1), and from each step's
 * "Back"/"Continue" handlers (passphraseStep.js, geminiStep.js).
 *
 * Cross-file dependencies (call-time only): $ / $$ (state.js),
 * currentStep (state.js — reassigned here).
 */

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

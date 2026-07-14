/**
 * onboarding/state.js — Shared state for the first-launch wizard.
 *
 * Loaded FIRST. Provides:
 *   - $ / $$ helpers (querySelector / querySelectorAll shorthand —
 *     used by every other split file)
 *   - currentStep let (mutated by showStep in stepNavigation.js)
 *   - totalSteps const (3 — was 4 before platform sign-in was removed
 *     from the wizard; see the loader's header comment for the full
 *     rationale)
 *   - collected const — accumulator object passed to
 *     window.gtss.onboarding.complete() at the end: passphrase (Step 1),
 *     geminiKey (Step 2, null if skipped), geminiKeyValid (Step 2
 *     validation result; false = invalid, true = valid, null = untried)
 *   - STAGE_ORDER const — the canonical stage identifiers emitted by
 *     the main process's "onboarding:progress" IPC channel, in the
 *     visual order they appear in the finish-progress checklist:
 *     [server, browser, clone, endpoint, ready]
 *   - finishProgressEl / finishErrorEl / finishStepEls — cached DOM
 *     refs for the finish-step progress checklist (populated here via
 *     a top-level STAGE_ORDER.forEach so every markFinishStage* helper
 *     in finishProgress.js can look up step elements by bare name)
 *
 * Cross-file dependencies: none at parse time. The DOM must be parsed
 * (the loader's <script src="onboarding.js"> sits at end-of-body in
 * onboarding.html line 169, so every #step-* and #finish-* element
 * above it is already in the DOM by the time this runs).
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

const STAGE_ORDER = ["server", "browser", "clone", "endpoint", "ready"];

const finishProgressEl = $("#finish-progress");
const finishErrorEl = $("#finish-progress-error");
const finishStepEls = {};
STAGE_ORDER.forEach((key) => {
  finishStepEls[key] = finishProgressEl?.querySelector(`[data-stage="${key}"]`);
});

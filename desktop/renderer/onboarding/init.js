/**
 * onboarding/init.js — Wizard boot.
 *
 * Loaded LAST. Calls showStep(1) at script-load time so the wizard
 * starts at step 1 (Passphrase). This matches the original
 * onboarding.js, whose final top-level statement was `showStep(1);`.
 *
 * MUST load AFTER stepNavigation.js (which declares showStep) — the
 * call here is a top-level statement that executes at parse time, so
 * `showStep` must already be a global property by the time this
 * script's top-level runs. (Function declarations in earlier-loaded
 * classic scripts are hoisted to the global object during their own
 * script's evaluation, so by the time init.js runs, `showStep` exists
 * as a global property.)
 *
 * Cross-file dependencies (parse-time): showStep (stepNavigation.js).
 */

// Start at step 1.
showStep(1);

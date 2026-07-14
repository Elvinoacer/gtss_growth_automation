/**
 * onboarding.js — first-launch wizard logic (module loader).
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
 *
 * ─── Module-loader split ────────────────────────────────────────────────
 *
 * This file is a thin loader. The actual wizard code has been split
 * into thematic files in the onboarding/ subdirectory for maintainability
 * (each <500 lines). Each split file is loaded synchronously via
 * document.write() during the initial page parse, preserving the
 * original single-<script> behavior — the HTML still references
 * `onboarding.js`, and every split file shares the same global scope
 * exactly as the original classic <script> did. The original was NOT
 * an IIFE — every `let`/`const`/`function` was a top-level global that
 * other scripts on the page could reference by bare name; the split
 * preserves that exact surface via the global lexical environment
 * shared across classic scripts.
 *
 * File manifest (loaded in dependency order):
 *   onboarding/state.js                  — $ / $$ helpers, currentStep let,
 *                                          totalSteps / collected consts,
 *                                          STAGE_ORDER const,
 *                                          finishProgressEl /
 *                                          finishErrorEl / finishStepEls
 *                                          cached DOM refs (populated via
 *                                          top-level STAGE_ORDER.forEach).
 *                                          Loaded FIRST.
 *   onboarding/toast.js                  — toast(message, kind, durationMs)
 *   onboarding/stepNavigation.js         — showStep(n) (mutates currentStep;
 *                                          called at boot by init.js)
 *   onboarding/passphraseStep.js         — Step 1: toggle-visibility wiring
 *                                          (top-level $$(".toggle-visibility")
 *                                          .forEach), passphrase DOM refs,
 *                                          updatePassphraseMatch,
 *                                          updatePassphraseStrength,
 *                                          input listeners + step1-next
 *                                          validation.
 *   onboarding/geminiStep.js             — Step 2: open-AI-Studio link,
 *                                          geminiKey DOM refs, input +
 *                                          skip listeners,
 *                                          validateGeminiKey (async),
 *                                          validateKey click + blur
 *                                          listeners, step2-back +
 *                                          step2-next validation.
 *   onboarding/finishProgress.js         — showFinishProgress,
 *                                          markFinishStageActive,
 *                                          markFinishStageDone,
 *                                          markFinishStageError,
 *                                          markFinishStageWarning,
 *                                          markAllFinishStagesDone.
 *   onboarding/finishProgressListener.js — let progressUnsubscribe (module-
 *                                          private), startFinishProgressListener,
 *                                          stopFinishProgressListener
 *                                          (subscribes to the
 *                                          onboarding:progress IPC channel).
 *   onboarding/finishHandlers.js         — Finish button click listener +
 *                                          Restart Chrome button click
 *                                          listener (both top-level).
 *   onboarding/init.js                   — `showStep(1)` boot call. Loaded
 *                                          LAST. MUST load after
 *                                          stepNavigation.js (which
 *                                          declares showStep) because the
 *                                          call here is a top-level
 *                                          statement executed at parse
 *                                          time.
 *
 * Original onboarding.js was ~555 lines; this loader is the only file
 * the HTML references directly (see desktop/renderer/onboarding.html
 * line 169).
 */

(function () {
  // The split files in dependency order. state.js loads first (it
  // declares every shared `const`/`let` binding in the global lexical
  // environment, plus the top-level STAGE_ORDER.forEach that populates
  // finishStepEls). init.js loads last because its top-level `showStep(1)`
  // call executes at parse time — `showStep` must already be a global
  // property by then (which it will be, since stepNavigation.js loaded
  // earlier and its function declaration was hoisted to the global
  // object during that script's evaluation). The mid-list ordering
  // (toast → stepNavigation → passphraseStep → geminiStep →
  // finishProgress → finishProgressListener → finishHandlers) follows
  // the wizard's step order so a reader can scan the manifest top-to-
  // bottom and follow the wizard's UX flow.
  var files = [
    'onboarding/state.js',
    'onboarding/toast.js',
    'onboarding/stepNavigation.js',
    'onboarding/passphraseStep.js',
    'onboarding/geminiStep.js',
    'onboarding/finishProgress.js',
    'onboarding/finishProgressListener.js',
    'onboarding/finishHandlers.js',
    'onboarding/init.js'
  ];

  // Resolve the base URL of THIS script (onboarding.js) so the split
  // files load from the same directory regardless of whether the
  // renderer is loaded via `file://` (the default Electron packaging)
  // or via `http://` (during dev). `document.currentScript.src` is
  // e.g. "file:///.../desktop/renderer/onboarding.js" (or
  // "http://host:port/onboarding.js"); stripping the trailing
  // "onboarding.js" leaves the directory base, so e.g.
  // "onboarding/state.js" resolves to "<base>/onboarding/state.js".
  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/onboarding\.js$/, '')
    : '';

  // document.write() of a <script> tag during parse is synchronous — the
  // browser blocks on fetching and executing each script before moving on.
  // This is exactly what we want: it preserves the original "everything
  // available by the time the user can interact" guarantee, since the
  // <script src="onboarding.js"> tag sits at end-of-body in
  // onboarding.html line 169 — every DOM element above it (including all
  // #step-1/2/3 panels, #onboard-passphrase, #onboard-gemini-key, etc.)
  // is already parsed by the time the loader's split files execute their
  // top-level statements.
  files.forEach(function (f) {
    document.write('<script src="' + base + f + '"><\/script>');
  });
})();

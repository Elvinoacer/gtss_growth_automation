/**
 * ipc-handlers/onboardingHandlers.js
 *
 * Registers the first-run onboarding IPC channels:
 *   - onboarding:status   — poll whether first-run onboarding is required
 *   - onboarding:complete — finish onboarding with passphrase + Gemini key,
 *                            then run the full startup (server + browser)
 *                            with live progress events streamed back to the
 *                            onboarding window via "onboarding:progress"
 *
 * The `onboarding:complete` handler is the key entry point for the
 * onboarding wizard's Finish step:
 *   1. await firstRun.complete(passphrase, geminiKey) — persists the
 *      passphrase hash + Gemini key into envBootstrap.
 *   2. await onOnboardingComplete(progressCallback) — runs the full
 *      server + browser startup. The progressCallback forwards each
 *      (stage, message) tuple to the onboarding window's renderer via
 *      webContents.send("onboarding:progress", { stage, message, ts }).
 *      The renderer shows each stage on its progress checklist.
 *   3. On success, onOnboardingComplete swaps windows — by the time the
 *      IPC resolves, the user is in the launcher.
 *
 * Required ctx: ipcMain, firstRun, getMainWindow, onOnboardingComplete
 */

function registerOnboardingIpc(ctx) {
  const { ipcMain, firstRun, getMainWindow, onOnboardingComplete } = ctx;

  ipcMain.handle("onboarding:status", async () => ({
    required: await firstRun.isRequired(),
  }));

  ipcMain.handle("onboarding:complete", async (_event, payload) => {
    try {
      await firstRun.complete(payload.passphrase, payload.geminiKey);
      // ─── Run the full startup WITH live progress events ───────────────
      //
      // Previously this was fire-and-forget: onOnboardingComplete() was
      // called without await, the IPC returned immediately, and main.js
      // did the window swap + server startup in the background. The user
      // saw a brief flash of "background tasks" and was immediately
      // redirected to the launcher — without any visibility into what
      // was happening.
      //
      // Now we AWAIT onOnboardingComplete(). It runs the full server +
      // browser startup, streaming progress events back to the onboarding
      // window via webContents.send("onboarding:progress", ...). The
      // renderer shows each stage on its progress screen. Only after
      // startup succeeds does onOnboardingComplete() swap windows — so
      // by the time the IPC resolves, the user is already in the
      // launcher. (If startup fails, onOnboardingComplete throws, the
      // IPC returns { ok:false, error }, and the renderer shows the
      // error in-place — the onboarding window stays open for retry.)
      if (typeof onOnboardingComplete === "function") {
        await onOnboardingComplete((stage, message) => {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("onboarding:progress", {
              stage,
              message,
              ts: Date.now(),
            });
          }
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerOnboardingIpc };

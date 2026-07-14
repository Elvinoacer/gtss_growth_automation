/**
 * ipc-handlers/index.js — Public entry point for `require("../main/ipc-handlers")`.
 *
 * Preserves the EXACT module.exports surface of the original
 * ipc-handlers.js monolith:
 *   module.exports = { registerIpcHandlers }
 *
 * `registerIpcHandlers(ctx)` is the same single-function public API the
 * original file exposed. It builds the IPC handler registrations by
 * delegating to thematic sub-registrars (one per concern: lifecycle, CDP,
 * Gemini+app, logs, onboarding, updater, folders). Each sub-registrar
 * receives the same `ctx` so it can pull out exactly the deps it needs.
 *
 * The split files live one directory deeper than the original, so the
 * one require() that left the original file — `require("./cdp-manager")`
 * for `validateGeminiApiKey` — became `require("../cdp-manager")` inside
 * geminiAndAppHandlers.js (both files live at desktop/main/, and the
 * cdp-manager split directory lives at desktop/main/cdp-manager/index.js).
 *
 * File manifest:
 *   lifecycleHandlers.js       — lifecycle:* (start/stop/restart/status/
 *                                open-devtools) + isSigninComplete helper
 *   cdpHandlers.js             — cdp:* (start/stop/restart/start-standalone/
 *                                open-login-tabs/open-url-in-cdp/
 *                                check-sessions/state)
 *   geminiAndAppHandlers.js    — gemini:validate-key + app:open-in-browser +
 *                                app:open-external
 *   logHandlers.js             — logs:snapshot + logs:line push + logs:clear
 *   onboardingHandlers.js      — onboarding:status + onboarding:complete
 *                                (with live progress events)
 *   updaterHandlers.js         — updater:* (status/check/download/install/
 *                                set-auto-download) + state-changed push +
 *                                startPeriodicChecks()
 *   folderHandlers.js          — open:data-folder + open:data-folder-info
 *   index.js                   — this file
 */

/**
 * Register every IPC channel. The original monolith did this in one giant
 * function body; we preserve the exact same ctx signature and behavior by
 * delegating to one sub-registrar per concern.
 *
 * @param {Object} ctx
 * @param {Object} ctx.ipcMain              Electron's ipcMain
 * @param {Object} ctx.lifecycle            Lifecycle controller
 * @param {Object} [ctx.serverManager]      (unused by split files, retained
 *                                          for ctx shape compat with callers)
 * @param {Object} ctx.cdpManager           CdpManager instance
 * @param {Object} ctx.envBootstrap         EnvBootstrap instance
 * @param {Object} ctx.firstRun             FirstRun instance
 * @param {Object} ctx.logStream            LogStream instance
 * @param {Object} ctx.updater              Updater instance
 * @param {Function} ctx.getMainWindow      () => BrowserWindow | null
 * @param {Function} [ctx.onOnboardingComplete]  (progressCb) => Promise<void>
 */
function registerIpcHandlers(ctx) {
  // Each sub-registrar pulls the deps it needs from ctx. Passing the
  // whole ctx keeps the call sites uniform and lets future handlers
  // reach for new deps without changing this dispatcher.
  require("./lifecycleHandlers").registerLifecycleIpc(ctx);
  require("./cdpHandlers").registerCdpIpc(ctx);
  require("./geminiAndAppHandlers").registerGeminiAndAppIpc(ctx);
  require("./logHandlers").registerLogIpc(ctx);
  require("./onboardingHandlers").registerOnboardingIpc(ctx);
  require("./updaterHandlers").registerUpdaterIpc(ctx);
  require("./folderHandlers").registerFolderIpc(ctx);
}

module.exports = { registerIpcHandlers };

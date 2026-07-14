/**
 * ipc-handlers/geminiAndAppHandlers.js
 *
 * Registers the Gemini-API-key validation channel and the two
 * "open-the-web-app / open-external-URL" channels:
 *   - gemini:validate-key    — live Gemini API key validation (hits the
 *                              list-models endpoint; treats 429 as VALID)
 *   - app:open-in-browser    — open the web app in the user's DEFAULT
 *                              browser via shell.openExternal
 *   - app:open-external      — open an arbitrary http(s) URL in the user's
 *                              DEFAULT browser (used by the "Missing
 *                              sessions" modal so logins happen where the
 *                              user already has sessions)
 *
 * Required ctx: ipcMain, lifecycle
 * Plus a require-time dep on `./cdp-manager` for `validateGeminiApiKey`
 * (same relative path as the original ipc-handlers.js — both files live
 * in desktop/main/, and the cdp-manager split directory lives at
 * desktop/main/cdp-manager/index.js).
 */

const { validateGeminiApiKey } = require("../cdp-manager");

function registerGeminiAndAppIpc(ctx) {
  const { ipcMain, lifecycle } = ctx;

  // ─── Gemini API key validation ─────────────────────────────────────────
  //
  // Lightweight validation that an API key is genuinely a Google AI Studio
  // key. Hits the list-models endpoint (cheap, no quota impact) and treats
  // 429 (quota exceeded) as VALID — per requirements, we only care whether
  // the key itself is valid, not whether the user has hit a rate limit.
  // Returns { ok, valid, reason } so the renderer can show:
  //   ✅ API key is valid
  //   ❌ Invalid API key (HTTP 401)
  ipcMain.handle("gemini:validate-key", async (_event, apiKey) => {
    try {
      const result = await validateGeminiApiKey(apiKey);
      return result;
    } catch (err) {
      return { ok: false, valid: false, reason: err.message };
    }
  });

  // ─── Open the web app ───────────────────────────────────────────────────
  //
  // Always opens in the user's DEFAULT browser via shell.openExternal.
  // Previously this opened a tab inside the running CDP Chrome (via the
  // DevTools HTTP API) — but that tied the web-app tab to the CDP Chrome,
  // which felt "embedded inside Electron". Now the web app always opens
  // in the user's normal browser. See Lifecycle.openWebApp().

  ipcMain.handle("app:open-in-browser", async () => {
    try {
      await lifecycle.openWebApp();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Open an arbitrary URL in the user's default browser ──────────────
  //
  // Used by the "Missing sessions" modal in the launcher — each platform
  // (LinkedIn, Facebook, Instagram, Google Gemini) gets an "Open ↗"
  // button that calls this with the platform's login URL. The URL opens
  // in the user's DEFAULT browser (not the CDP Chrome), so the user
  // signs in where they're already comfortable and where their existing
  // sessions live.
  //
  // This is the key change for "authentication in the browser, not
  // inside Electron": previously the modal called cdp:open-url-in-cdp
  // which opened login pages inside the CDP Chrome that Electron
  // spawned. Now we always shell.openExternal — the CDP Chrome still
  // runs for automation, but authentication happens in the user's
  // normal browser.
  ipcMain.handle("app:open-external", async (_event, url) => {
    try {
      if (!url || typeof url !== "string") {
        return { ok: false, error: "No URL provided." };
      }
      // Only allow http(s) URLs — never file://, javascript:, etc.
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "Only http(s) URLs are allowed." };
      }
      const { shell } = require("electron");
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerGeminiAndAppIpc };

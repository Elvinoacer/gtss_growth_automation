/**
 * Automation Routes — Open Manual Browser
 *
 * Express handler for opening a manual (non-headless) Chrome session for a
 * given platform — used when the user needs to fix a CAPTCHA, re-login, or
 * otherwise unblock automation by hand:
 *   POST /api/automation/open-browser/:platform — Launch a visible browser pointed at the platform home
 *
 * Note: /api/sessions/authenticate/:platform is handled separately in api.js.
 *
 * Cross-file dependencies: ../../automation/browserBase (createBrowser,
 * getProfileDir) — required lazily inside the handler to avoid loading the
 * Playwright stack on every other automation route.
 *
 * Extracted from the original routes/automation.js for maintainability.
 */

/**
 * Register the open-browser route on the given router.
 *
 * @param {import('express').Router} router
 */
function registerBrowserRoutes(router) {
  // Open a manual browser to fix captcha
  router.post("/api/automation/open-browser/:platform", async (req, res) => {
    const { platform } = req.params;
    try {
      const {
        createBrowser,
        getProfileDir,
      } = require("../../automation/browserBase");
      const browserState = await createBrowser(platform, {
        headless: false,
        trace: false,
      });
      const { page } = browserState;
      await page.goto(`https://www.${platform}.com`);

      res.json({
        success: true,
        mode: browserState.mode,
        profileDir:
          browserState.mode === "persistent" ? getProfileDir(platform) : null,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerBrowserRoutes };

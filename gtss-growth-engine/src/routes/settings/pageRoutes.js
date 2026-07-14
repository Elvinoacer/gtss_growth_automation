/**
 * Settings Routes — Page Render
 *
 * Express handler for the Settings page itself (the HTML shell — the actual
 * settings form is hydrated client-side via the API routes):
 *   GET /  — Render the Settings page (mounted under /settings by server.js)
 *
 * Cross-file dependencies: ../pageRenderer.
 *
 * Extracted from the original routes/settings.js for maintainability.
 */

const { renderPage } = require("../pageRenderer");

/**
 * Register the settings page route on the given router (the pageRouter
 * from index.js, mounted at /settings by server.js).
 *
 * @param {import('express').Router} router
 */
function registerPageRoutes(router) {
  router.get("/", (req, res) => {
    renderPage(res, {
      title: "Settings",
      primaryHeading: "Configure growth engine",
      primaryCopy:
        "Update limits, templates, account credentials, and platform session storage settings.",
    });
  });
}

module.exports = { registerPageRoutes };

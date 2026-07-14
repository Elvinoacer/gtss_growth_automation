/**
 * messages/pageRoutes.js — GET /messages page route.
 *
 * Renders the Messages page via the shared `renderPage` helper.
 *
 * Original routes/messages.js was 561 lines; this is one of its thematic
 * splits. The relative require path was updated for the new directory depth
 * (one extra `..` for src/routes/pageRenderer).
 */

const { renderPage } = require("../pageRenderer");

module.exports = function registerPageRoutes(router) {
  router.get("/messages", (req, res) => {
    renderPage(res, {
      title: "Messages",
      primaryHeading: "Outreach workspace",
      primaryCopy:
        "Draft, personalize, approve, and track direct messages across supported platforms.",
    });
  });
};

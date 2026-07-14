/**
 * campaigns/pageRouter.js
 *
 * Builds and exports the campaign page-views sub-router (the original
 * `pageRouter` attached as `module.exports.pageRouter` on the main router).
 *
 * Routes registered:
 *   GET /campaigns      — render the campaigns listing page
 *   GET /campaigns/:id  — render a single campaign's detail page
 *
 * The detail-page route validates the campaign ID, looks the campaign up
 * in the DB (404 if missing), and forwards the campaign name + ID to
 * `renderPage` so the page renderer can populate the heading.
 *
 * Required deps (passed in via `requireDeps`):
 *   - express (to create the sub-router)
 *   - getDb
 *   - renderPage (from ../pageRenderer)
 */

function buildPageRouter({ requireDeps }) {
  const { express, getDb, renderPage } = requireDeps();

  const pageRouter = express.Router();

  pageRouter.get("/campaigns", (req, res) => {
    renderPage(res, {
      title: "Campaigns",
      primaryHeading: "Campaign outreach pipelines",
      primaryCopy: "Create, configure, and monitor your multi-channel automated campaigns."
    });
  });

  pageRouter.get("/campaigns/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).send("Invalid campaign ID.");
    }
    const db = getDb();
    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    if (!campaign) {
      return res.status(404).send("Campaign not found.");
    }
    renderPage(res, {
      title: "CampaignDetail",
      primaryHeading: campaign.name,
      campaignId: campaign.id
    });
  });

  return pageRouter;
}

module.exports = { buildPageRouter };

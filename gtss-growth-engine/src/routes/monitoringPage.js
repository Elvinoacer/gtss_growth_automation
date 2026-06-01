/**
 * monitoringPage.js - Page route for /monitoring
 */
const express = require("express");
const { renderPage } = require("./pageRenderer");

const router = express.Router();

router.get("/monitoring", (req, res) => {
  renderPage(res, {
    title: "Monitoring",
    primaryHeading: "Monitoring",
    primaryCopy:
      "Track pipeline health, retries, and failures with persistent logs.",
  });
});

module.exports = router;

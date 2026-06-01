const express = require("express");
const { renderPage } = require("./pageRenderer");

const router = express.Router();

router.get("/assets", (_req, res) => {
  renderPage(res, {
    title: "AssetLibrary",
    primaryHeading: "Asset Library",
    primaryCopy: "Manage reusable media for the content pipeline.",
  });
});

module.exports = router;

const express = require("express");
const { renderPage } = require("./pageRenderer");

const router = express.Router();

router.get("/audit", (_req, res) => {
  renderPage(res, {
    title: "AuditLog",
    primaryHeading: "Audit Log",
    primaryCopy: "Review execution history across pipelines and automation.",
  });
});

module.exports = router;

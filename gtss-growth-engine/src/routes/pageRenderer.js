const { renderPage: renderHtmlPage } = require("../utils/renderPage");

const fileMap = {
  Dashboard: "dashboard.html",
  Discovery: "discovery.html",
  Qualification: "lead-qualification.html",
  Messages: "message-generator.html",
  Automation: "automation.html",
  CRM: "crm.html",
  Scheduler: "content-scheduler.html",
  Settings: "settings.html",
  InstagramWarmup: "instagram-warmup.html",
  Campaigns: "campaigns.html",
  CampaignDetail: "campaign-detail.html",
  Pipelines: "pipelines.html",
  Monitoring: "monitoring.html",
  AssetLibrary: "asset-library.html",
  AuditLog: "audit-log.html",
};

function renderPage(res, page) {
  const fileName = fileMap[page.title] || "dashboard.html";
  renderHtmlPage(res, fileName, page);
}

module.exports = {
  renderPage,
};

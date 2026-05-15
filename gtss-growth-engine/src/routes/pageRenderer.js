const { renderPage: renderHtmlPage } = require('../utils/renderPage');

const fileMap = {
  Dashboard: 'dashboard.html',
  Discovery: 'discovery.html',
  Qualification: 'lead-qualification.html',
  Messages: 'message-generator.html',
  Automation: 'automation.html',
  CRM: 'crm.html',
  Scheduler: 'content-scheduler.html',
  Settings: 'settings.html'
};

function renderPage(res, page) {
  const fileName = fileMap[page.title] || 'dashboard.html';
  renderHtmlPage(res, fileName, page);
}

module.exports = {
  renderPage
};

const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '..', '..', 'public', 'pages');
const shellPath = path.join(__dirname, '..', '..', 'public', 'partials', 'shell.html');

function escapeScriptJson(data) {
  return JSON.stringify(data || {}).replace(/</g, '\\u003c');
}

function renderPage(res, pageFile, data = {}) {
  const pagePath = path.join(pagesDir, pageFile);
  const shell = fs.readFileSync(shellPath, 'utf8');
  let html = fs.readFileSync(pagePath, 'utf8');
  const pageDataScript = `<script>window.__PAGE_DATA__ = ${escapeScriptJson(data)};</script>`;

  if (html.includes('<!-- SHELL -->')) {
    html = html.replace('<!-- SHELL -->', shell);
  } else {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${shell}`);
  }

  if (html.includes('</body>')) {
    html = html.replace('</body>', `${pageDataScript}</body>`);
  } else {
    html += pageDataScript;
  }

  res.type('html').send(html);
}

module.exports = {
  renderPage
};

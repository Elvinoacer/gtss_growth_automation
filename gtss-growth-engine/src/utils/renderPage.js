const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '..', '..', 'public', 'pages');
const shellPath = path.join(__dirname, '..', '..', 'public', 'partials', 'shell.html');

function escapeScriptJson(data) {
  return JSON.stringify(data || {}).replace(/</g, '\\u003c');
}

/**
 * Recursively inline `<div data-include="...">` (and `<section>`, `<main>`,
 * `<aside>`) placeholders with the contents of the referenced HTML file.
 *
 * Paths are resolved relative to `pagesDir` (the same `public/pages/`
 * directory the page itself lives in), so e.g. `data-include="settings/api.html"`
 * resolves to `public/pages/settings/api.html`.
 *
 * Supports nested includes (an included file may itself contain
 * `data-include` placeholders) up to a small depth limit to prevent infinite
 * recursion from a self-referential partial. Unknown files are left as a
 * visible HTML comment so a missing partial is easy to spot in dev tools
 * rather than silently rendering as an empty div.
 *
 * This is a pure string-substitution include — no expression evaluation, no
 * templating — so it does not change the rendering semantics of any page
 * that does not contain `data-include` attributes. The existing `<!-- SHELL -->`
 * include runs separately below.
 */
const INCLUDE_RE = /<(div|section|main|aside)([^>]*?)\s+data-include="([^"]+)"([^>]*)>\s*<\/\1>/gi;
const INCLUDE_DEPTH_LIMIT = 5;

function resolveIncludes(html, depth = 0) {
  if (depth >= INCLUDE_DEPTH_LIMIT || !INCLUDE_RE.test(html)) {
    return html;
  }
  INCLUDE_RE.lastIndex = 0;
  return html.replace(INCLUDE_RE, (match, tag, preAttrs, includePath, postAttrs) => {
    const trimmed = String(includePath).trim();
    // Guard against path traversal: only allow paths that resolve strictly
    // inside pagesDir.
    const fullPath = path.resolve(pagesDir, trimmed);
    const rel = path.relative(pagesDir, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(trimmed)) {
      return `<!-- data-include: invalid path "${trimmed}" -->`;
    }
    try {
      const partial = fs.readFileSync(fullPath, 'utf8');
      return resolveIncludes(partial, depth + 1);
    } catch (err) {
      return `<!-- data-include: missing partial "${trimmed}" -->`;
    }
  });
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

  // Resolve `<... data-include="...">` placeholders after the shell is inlined
  // so partials may themselves reference shell-injected markup if needed.
  html = resolveIncludes(html);

  if (html.includes('</head>')) {
    html = html.replace('</head>', `${pageDataScript}</head>`);
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', `${pageDataScript}</body>`);
  } else {
    html += pageDataScript;
  }

  res.type('html').send(html);
}

module.exports = {
  renderPage
};

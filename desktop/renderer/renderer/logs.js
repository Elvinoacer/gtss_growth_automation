/**
 * renderer/logs.js — Logs pane (live tail + filter checkboxes + clear).
 *
 * Subscribes to window.gtss.logs.onLine() for live tailing, keeps the last
 * 5000 entries in memory, applies the 4 source-filter checkboxes (server /
 * cdp / lifecycle / updater) on both initial snapshot render and on each
 * inbound line, and supports a Clear button that wipes the pane + the
 * backend log buffer.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window, document */

const logsPane = $("#logs-pane");
const filters = {
  server: $("#log-filter-server"),
  cdp: $("#log-filter-cdp"),
  lifecycle: $("#log-filter-lifecycle"),
  updater: $("#log-filter-updater"),
};

let logEntries = [];

function sourceMatchesFilter(source) {
  if (source.startsWith("server")) return filters.server.checked;
  if (source.startsWith("cdp")) return filters.cdp.checked;
  if (source.startsWith("lifecycle")) return filters.lifecycle.checked;
  if (source.startsWith("updater")) return filters.updater.checked;
  return true;
}

function renderLogEntry(entry) {
  const cls = entry.source.endsWith("stderr") ? " stderr" : "";
  const sourceCls = entry.source.startsWith("lifecycle") ? " lifecycle" : "";
  const time = new Date(entry.ts).toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `log-line${cls}${sourceCls}`;
  div.innerHTML = `<span class="log-time">${time}</span>
    <span class="log-source">${escapeHtml(entry.source)}</span>
    <span class="log-text">${escapeHtml(entry.line)}</span>`;
  return div;
}

function renderLogs() {
  const visible = logEntries.filter((e) => sourceMatchesFilter(e.source));
  if (visible.length === 0) {
    logsPane.innerHTML = '<div class="logs-empty">No logs match the current filters.</div>';
    return;
  }
  logsPane.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.appendChild(renderLogEntry(e));
  logsPane.appendChild(frag);
  logsPane.scrollTop = logsPane.scrollHeight;
}

async function loadInitialLogs() {
  logEntries = await window.gtss.logs.snapshot();
  renderLogs();
}

window.gtss.logs.onLine((entry) => {
  logEntries.push(entry);
  if (logEntries.length > 5000) logEntries.shift();
  if (sourceMatchesFilter(entry.source)) {
    const empty = logsPane.querySelector(".logs-empty");
    if (empty) logsPane.innerHTML = "";
    logsPane.appendChild(renderLogEntry(entry));
    while (logsPane.children.length > 5000) {
      logsPane.removeChild(logsPane.firstChild);
    }
    logsPane.scrollTop = logsPane.scrollHeight;
  }
});

Object.values(filters).forEach((f) => f.addEventListener("change", renderLogs));
$("#logs-clear-btn").addEventListener("click", async () => {
  await window.gtss.logs.clear();
  logEntries = [];
  renderLogs();
});

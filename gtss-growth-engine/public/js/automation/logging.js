/* global gtss */
/**
 * automation/logging.js — Real-time log panel for the Automation Control
 * page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 615-643).
 * appendLog is called by execution.js's onAutomationLog socket handler
 * for every automation:* event.
 *
 * Exposes (via global scope):
 *   - appendLog(type, msg, data={}) — appends a timestamped log line to
 *     #log-container, colored by type (info=primary, error/captcha=error,
 *     warn=secondary, done=primary). Auto-scrolls if the autoscroll
 *     checkbox is checked.
 *
 * Top-level bindings (registered at script-load time):
 *   - logClearBtn "click" → empty the log container
 */

// ----------------------------------------------------------------
// Logging
// ----------------------------------------------------------------

function appendLog(type, msg, data = {}) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  let typeClass = "text-primary-fixed-dim";
  if (type === "error" || type === "captcha") typeClass = "text-error";
  else if (type === "warn") typeClass = "text-secondary-fixed-dim";
  else if (type === "done") typeClass = "text-primary";

  const div = document.createElement("div");
  div.className = "flex gap-3 mb-1.5";
  div.innerHTML = `
    <span class="text-outline shrink-0">[${time}]</span>
    <span class="${typeClass} shrink-0 w-12 font-bold">${type.toUpperCase()}</span>
    <span class="text-inverse-on-surface">${msg}</span>
  `;

  logContainer.appendChild(div);

  if (logAutoScroll.checked) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

logClearBtn.addEventListener("click", () => {
  logContainer.innerHTML = "";
});

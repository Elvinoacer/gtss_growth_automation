/* global gtss */
/**
 * automation/helpers.js — Small shared helpers for the Automation Control
 * page.
 *
 * Pulled verbatim from the original automation.js IIFE. The original
 * defined `escapeHtml` TWICE inside the same IIFE — once at line 86 (DOM
 * based: textContent → innerHTML) right next to the DOM-recorder code, and
 * again at line 595 (regex based: 5 chained `.replace()` calls) next to
 * the queue-rendering code. Function declarations inside a single function
 * scope are both hoisted; the SECOND declaration wins, so at runtime every
 * caller (DOM recorder, queue table, run summary, retry-by-category
 * buttons) used the regex version.
 *
 * To keep the split clean and avoid duplicate-declaration noise across
 * files, only the regex-based version is included here, and it lives in
 * the shared global lexical environment so every other split file can
 * reference it by bare name.
 *
 * Exposes (via global scope):
 *   - escapeHtml(value) — regex-based HTML escaper
 *   - formatDateTime(value) — parses a "YYYY-MM-DD HH:MM:SS" string and
 *     returns a localized "Mon DD, HH:MM" string (used by queue rows for
 *     the snooze-until column)
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

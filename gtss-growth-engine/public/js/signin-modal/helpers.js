/**
 * signin-modal/helpers.js — escapeHtml and showToast wrappers.
 *
 * Original signin-modal.js was 656 lines; this is one of its thematic splits.
 */

"use strict";

function escapeHtml(text) {
  if (typeof text !== "string") return String(text || "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message, type) {
  if (window.gtss && typeof window.gtss.showToast === "function") {
    window.gtss.showToast(message, type, 5000);
  }
}

/**
 * renderer/helpers.js — shared DOM + UI helpers used by every split file.
 *
 * Loaded FIRST so the rest of the splits can reference $, $$, toast, and
 * escapeHtml by bare name in the global lexical environment shared across
 * classic <script> files. No IIFE — globals are intentional (same pattern
 * as the original renderer.js monolith).
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global window, document */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/**
 * Escape a string for safe insertion into HTML text content / attributes.
 * Used by the Logs pane (renderLogEntry) to avoid log-driven XSS.
 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Show a transient toast notification.
 *
 * @param {string} message - Text to display.
 * @param {string} [kind="info"] - One of "info" / "success" / "error".
 */
function toast(message, kind = "info") {
  const container = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

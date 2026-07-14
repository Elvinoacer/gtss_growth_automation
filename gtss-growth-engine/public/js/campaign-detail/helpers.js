/**
 * campaign-detail/helpers.js — Pure-ish rendering helpers for badges and
 * HTML escaping.
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// HTML-escape user-supplied strings before injecting into innerHTML.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tailwind badge classes for each platform label.
function getPlatformBadgeClass(platform) {
  const norm = String(platform).toLowerCase();
  switch (norm) {
    case "linkedin": return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    case "instagram": return "bg-pink-500/10 text-pink-400 border-pink-500/20";
    case "facebook": return "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
    case "x":
    case "twitter": return "bg-slate-500/10 text-slate-400 border-slate-500/20";
    default: return "bg-surface-container-high text-on-surface-variant border-outline-variant";
  }
}

// Tailwind badge styles for each campaign status (active / paused / etc.).
function getStatusBadgeStyle(status) {
  const norm = String(status).toLowerCase();
  switch (norm) {
    case "active":
      return {
        textColor: "text-primary",
        dotColor: "bg-primary border-primary/30",
        pulseClass: "animate-pulse",
        badgeBorder: "border-primary/20 bg-primary/5"
      };
    case "paused":
      return {
        textColor: "text-secondary",
        dotColor: "bg-secondary border-secondary/30",
        badgeBorder: "border-secondary/20 bg-secondary/5"
      };
    case "completed":
      return {
        textColor: "text-green-500",
        dotColor: "bg-green-500 border-green-500/30",
        badgeBorder: "border-green-500/20 bg-green-500/5"
      };
    case "draft":
    default:
      return {
        textColor: "text-outline",
        dotColor: "bg-outline border-outline/30",
        badgeBorder: "border-outline-variant/30 bg-surface-container"
      };
  }
}

// Tailwind badge classes for each job status (accepted / sent / failed / etc.).
function getJobStatusBadgeClass(status) {
  const norm = String(status).toLowerCase();
  switch (norm) {
    case "accepted":
    case "sent":
      return "bg-green-500/10 text-green-400 border border-green-500/20";
    case "failed":
      return "bg-red-500/10 text-red-400 border border-red-500/20";
    case "scheduled":
    case "sent_ready":
      return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
    case "running":
      return "bg-orange-500/10 text-orange-400 border border-orange-500/20 animate-pulse";
    case "pending":
    default:
      return "bg-slate-500/10 text-slate-400 border border-slate-500/20";
  }
}

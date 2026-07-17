/**
 * messageService/templates.js
 *
 * Template + per-platform character-limit helpers for outreach message
 * generation:
 *
 *  - CHAR_LIMITS / getCharLimit: hard caps per platform+messageType
 *    (linkedin_connect=300, linkedin_dm=1000, x_dm=500, ig/fb_dm=1000).
 *    The generators slice body to this limit so the platform never
 *    silently truncates our outreach.
 *  - loadTemplates / getTemplate: read the per-platform DM/connect
 *    template. Priority: settings table (template_<platform>_<type>) →
 *    file fallback config/templates.json. Empty string if neither has
 *    one (the caller falls back to a generic ctx_product_value_prop
 *    body in that case).
 *  - fillTemplate: simple {{var}} substitution.
 *  - getFirstName: first whitespace-separated token of a name, "there"
 *    if empty.
 *  - extractPainPoint: pick a contextual pain point from
 *    ctx_product_pain_points that matches the lead's score_reason
 *    (restaurant/hotel/cafe/outage keyword match), fall back to the
 *    first pain point or a generic "managing your operations more
 *    efficiently".
 *  - stripCodeFences: strip leading ```json / ``` and trailing ``` from
 *    an AI response (Gemini sometimes wraps single-message responses in
 *    code fences despite the prompt asking for plain text).
 */

const path = require("path");
const fs = require("fs");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");

const CHAR_LIMITS = {
  linkedin_connect: 300,
  linkedin_dm: 1000,
  x_dm: 500,
  instagram_dm: 1000,
  facebook_dm: 1000,
};

function getCharLimit(platform, type) {
  const key = `${platform}_${type || "dm"}`;
  return CHAR_LIMITS[key] || 1000;
}

function loadTemplates() {
  try {
    const filePath = path.join(__dirname, "..", "..", "config", "templates.json");
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    logger.error("MESSAGES", "Failed to load templates", {
      error: err.message,
    });
    return {};
  }
}

function getTemplate(platform, type) {
  const db = getDb();
  const settingKey = `template_${platform}_${type || "dm"}`;
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(settingKey);
  if (row && row.value) return row.value;

  const templates = loadTemplates();
  const fileKey = type ? `${platform}_${type}` : `${platform}_dm`;
  return templates[fileKey] || "";
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  return result;
}

function getFirstName(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) return "there";
  return cleaned.split(/\s+/)[0];
}

function extractPainPoint(scoreReason, painPoints) {
  // painPoints is the ctx_product_pain_points array from context
  const fallback =
    (painPoints && painPoints[0]) ||
    "managing your operations more efficiently";
  if (!scoreReason) return fallback;

  const lower = scoreReason.toLowerCase();
  if (!painPoints || !Array.isArray(painPoints)) return fallback;

  // Try to match a contextual pain point to the score reason keywords
  for (const point of painPoints) {
    const pointLower = point.toLowerCase();
    if (lower.includes("restaurant") && pointLower.includes("restaurant"))
      return point;
    if (lower.includes("hotel") && pointLower.includes("hotel")) return point;
    if (lower.includes("cafe") && pointLower.includes("cafe")) return point;
    if (lower.includes("outage") && pointLower.includes("outage")) return point;
  }

  return fallback;
}

function stripCodeFences(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return cleaned.trim();
}

/**
 * Clean AI/template outreach text so we never send placeholder tokens like
 * `[link]`, `[url]`, or empty markdown links.
 *
 * Production: Gemini invented `Book a free 15-min demo to see how: [link]`
 * because the prompt asked for a CTA without a real URL. This sanitizer is
 * the hard backstop; the prompt also forbids placeholders.
 *
 * @param {string} text
 * @param {{ websiteUrl?: string|null }} [opts]
 * @returns {string}
 */
function sanitizeOutreachBody(text, { websiteUrl = null } = {}) {
  let body = String(text || "");
  if (!body) return "";

  const site = String(websiteUrl || "")
    .trim()
    .replace(/\s+/g, "");
  const hasSite = /^https?:\/\/\S+/i.test(site);

  // Markdown images/links → plain text, optionally keep a real http(s) URL.
  body = body.replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1");
  body = body.replace(/\[([^\]]+)\]\((.*?)\)/g, (_, label, href) => {
    const h = String(href || "").trim();
    if (/^https?:\/\/\S+/i.test(h)) {
      return `${label} ${h}`.trim();
    }
    // Placeholder hrefs like (link), (url), (your-link) — drop the wrapper.
    return label;
  });

  // Bare placeholder tokens the model invents when it wants a URL slot.
  // If we have a real business website, substitute it; otherwise remove.
  const placeholderRe =
    /\[(?:link|url|website|site|demo(?:\s*link)?|insert\s*link|your\s*link|cta\s*link|here)\]/gi;
  if (hasSite) {
    body = body.replace(placeholderRe, site);
  } else {
    body = body.replace(placeholderRe, "");
  }

  // Parenthetical placeholders: (link), (insert url), etc.
  body = body.replace(
    /\(\s*(?:link|url|website|insert\s*link|your\s*link)\s*\)/gi,
    hasSite ? site : "",
  );

  // Angle-bracket placeholders: <link>, <url>
  body = body.replace(
    /<\s*(?:link|url|website|insert\s*link)\s*>/gi,
    hasSite ? site : "",
  );

  // Common AI filler left after stripping a missing URL:
  // "to see how:", "see how:", "click here:", dangling "to" at EOL, etc.
  body = body.replace(
    /\b(?:to\s+)?(?:see how|click here|visit here|check here|learn more here)\s*:?\s*(?=\n|$|[.!?])/gi,
    "",
  );
  // "Book a free 15-min demo to" → "Book a free 15-min demo"
  body = body.replace(/\bto\s*(?=\n|$)/gi, "");
  // Trailing ":" before newline after CTA cleanup ("demo:")
  body = body.replace(/:\s*(?=\n|$)/g, (match, offset, full) => {
    const rest = full.slice(offset + match.length);
    if (!rest || /^\s*(\n|$)/.test(rest)) return "";
    return match;
  });

  // Whitespace tidy
  body = body
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\./g, ".")
    .replace(/[ \t]+([,;!?])/g, "$1")
    .trim();

  return body;
}

module.exports = {
  CHAR_LIMITS,
  getCharLimit,
  loadTemplates,
  getTemplate,
  fillTemplate,
  getFirstName,
  extractPainPoint,
  stripCodeFences,
  sanitizeOutreachBody,
};

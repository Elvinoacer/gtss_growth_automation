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

module.exports = {
  CHAR_LIMITS,
  getCharLimit,
  loadTemplates,
  getTemplate,
  fillTemplate,
  getFirstName,
  extractPainPoint,
  stripCodeFences,
};

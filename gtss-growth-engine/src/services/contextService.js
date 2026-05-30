"use strict";

const { getDb } = require("../db/database");

// ─── DEFAULTS ────────────────────────────────────────────────────────────────
// These are the fallback values used when the admin has not yet configured context.
// They reflect the current hardcoded state of the engine so nothing breaks on first boot.

const DEFAULTS = {
  // Business Identity
  ctx_biz_name: "GTSS",
  ctx_biz_description:
    "A Kenyan tech company that builds restaurant management software for hospitality businesses in East Africa.",
  ctx_biz_industry: "Hospitality Technology",
  ctx_biz_location: "Nairobi, Kenya",
  ctx_biz_website: "https://gtss.software",

  // Product / Service
  ctx_product_name: "Restaurant Manager",
  ctx_product_tagline:
    "Keep your restaurant running even when the internet goes down.",
  ctx_product_description:
    "A localized POS and kitchen management system that runs 100% offline, keeps mobile payments and kitchen routing flowing, and syncs when connectivity returns.",
  ctx_product_key_features: JSON.stringify([
    "Offline-first operation",
    "Kitchen display routing",
    "M-Pesa & mobile payments integration",
    "Real-time sales reports",
  ]),
  ctx_product_pain_points: JSON.stringify([
    "ISP outages during peak hours",
    "Lost revenue during internet drops",
    "Split-check and order errors",
    "Inventory waste",
  ]),
  ctx_product_value_prop:
    "100% operational uptime even during internet outages - no more lost revenue on a bad connection day.",

  // Target Audience
  ctx_audience_industries: JSON.stringify([
    "restaurant",
    "cafe",
    "hotel",
    "bar",
    "lodge",
    "resort",
    "catering",
    "bakery",
    "pizzeria",
    "supper club",
  ]),
  ctx_audience_geographies: JSON.stringify([
    "Nairobi",
    "Mombasa",
    "Kenya",
    "East Africa",
  ]),
  ctx_audience_ideal_profile:
    "Owner or manager of a food & beverage or hospitality business in Kenya with 5-200 seats, actively using social media.",
  ctx_audience_exclude_industries: JSON.stringify([
    "fintech",
    "NGO",
    "government",
    "real estate",
    "consulting",
  ]),
  ctx_audience_scoring_weights: JSON.stringify({
    business_type: 30,
    location: 20,
    business_size: 20,
    completeness: 15,
    recency: 15,
  }),

  // Sender Identity
  ctx_sender_name: "Elvin",
  ctx_sender_full_name: "Elvin Omondi",
  ctx_sender_role: "Founder & CEO",
  ctx_sender_sign_off: "Best,\nElvin",

  // Content Style
  ctx_content_tone: "friendly, professional, conversational",
  ctx_content_language: "English",
  ctx_content_post_themes: JSON.stringify([
    "uptime reliability",
    "Kenyan hospitality",
    "technology made simple",
    "local success stories",
  ]),
  ctx_content_hashtag_sets: JSON.stringify({
    instagram: [
      "nairobieats",
      "nairobifood",
      "nairobirestaurants",
      "kenyahospitality",
    ],
    linkedin: ["kenyatech", "hospitality", "restauranttech"],
  }),
  ctx_content_image_style:
    "warm, photorealistic, modern restaurant interior, East African setting, natural lighting",
  ctx_content_cta: "Book a free 15-minute demo",
};

// JSON fields that should be parsed into arrays/objects when returned
const JSON_FIELDS = new Set([
  "ctx_product_key_features",
  "ctx_product_pain_points",
  "ctx_audience_industries",
  "ctx_audience_geographies",
  "ctx_audience_exclude_industries",
  "ctx_audience_scoring_weights",
  "ctx_content_post_themes",
  "ctx_content_hashtag_sets",
  "ctx_discovery_keywords",
]);

/**
 * Load the full context object from the database, merging with defaults.
 * Synchronous - SQLite read. Safe to call at the top of any function.
 * @returns {object}
 */
function getContext() {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'ctx_%'")
    .all();

  const stored = {};
  rows.forEach((r) => {
    stored[r.key] = r.value;
  });

  const merged = { ...DEFAULTS, ...stored };

  JSON_FIELDS.forEach((field) => {
    try {
      if (typeof merged[field] === "string") {
        merged[field] = JSON.parse(merged[field]);
      }
    } catch {
      // Keep as-is if parse fails
    }
  });

  return merged;
}

/**
 * Upsert a single context key into the settings table.
 * @param {string} key   Must start with ctx_
 * @param {*}      value String or JSON-serializable value
 */
function setContext(key, value) {
  if (!key.startsWith("ctx_"))
    throw new Error(`Context keys must start with ctx_. Got: ${key}`);
  const db = getDb();
  const strValue = typeof value === "string" ? value : JSON.stringify(value);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, strValue);
}

/**
 * Bulk-upsert multiple context values in a single transaction.
 * Keys not starting with ctx_ are silently skipped.
 * @param {object} updates  { [key: string]: any }
 */
function setContextBulk(updates) {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (!key.startsWith("ctx_")) continue;
      const strValue =
        typeof value === "string" ? value : JSON.stringify(value);
      stmt.run(key, strValue);
    }
  });
  txn();
}

/**
 * Reset all context keys to their default values.
 */
function resetContext() {
  setContextBulk(DEFAULTS);
}

module.exports = {
  getContext,
  setContext,
  setContextBulk,
  resetContext,
  DEFAULTS,
  JSON_FIELDS,
};

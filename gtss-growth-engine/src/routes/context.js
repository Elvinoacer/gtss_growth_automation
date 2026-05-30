"use strict";

const express = require("express");
const {
  getContext,
  setContextBulk,
  resetContext,
  DEFAULTS,
  JSON_FIELDS,
} = require("../services/contextService");

const router = express.Router();

// ── GET /api/context ──────────────────────────────────────────────────────────
// Returns the full merged context object (DB values + defaults).
router.get("/", (req, res) => {
  try {
    res.json(getContext());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/context ────────────────────────────────────────────────────────
// Accepts a flat object of { ctx_key: value } pairs. Validates all keys start with ctx_.
// JSON-field values may arrive as arrays/objects - they are serialized automatically.
router.patch("/", (req, res) => {
  try {
    const updates = req.body || {};
    const invalid = Object.keys(updates).filter((k) => !k.startsWith("ctx_"));
    if (invalid.length) {
      return res.status(400).json({
        error: `Invalid keys (must start with ctx_): ${invalid.join(", ")}`,
      });
    }

    // Validate required text fields are not blank if provided
    const requiredFields = [
      "ctx_biz_name",
      "ctx_product_name",
      "ctx_sender_name",
    ];
    for (const field of requiredFields) {
      if (field in updates) {
        const val =
          typeof updates[field] === "string" ? updates[field].trim() : "";
        if (!val) {
          return res.status(400).json({ error: `${field} cannot be blank.` });
        }
      }
    }

    // Validate scoring weights sum if provided
    if (updates.ctx_audience_scoring_weights) {
      let weights;
      try {
        weights =
          typeof updates.ctx_audience_scoring_weights === "string"
            ? JSON.parse(updates.ctx_audience_scoring_weights)
            : updates.ctx_audience_scoring_weights;
      } catch {
        return res
          .status(400)
          .json({ error: "ctx_audience_scoring_weights must be valid JSON." });
      }
      const total = Object.values(weights).reduce(
        (sum, v) => sum + Number(v),
        0,
      );
      if (total !== 100) {
        return res
          .status(400)
          .json({ error: `Scoring weights must sum to 100. Got ${total}.` });
      }
    }

    setContextBulk(updates);
    res.json({ success: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/context/reset ───────────────────────────────────────────────────
// Restores all context keys to their built-in defaults.
router.post("/reset", (req, res) => {
  try {
    resetContext();
    res.json({ success: true, context: getContext() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/context/defaults ─────────────────────────────────────────────────
// Returns the raw defaults object (useful for the UI to show placeholder text).
router.get("/defaults", (req, res) => {
  res.json(DEFAULTS);
});

// ── GET /api/context/preview ──────────────────────────────────────────────────
// Returns rendered prompt previews for all four AI workflows using the CURRENT
// saved context from the DB (not from request body).
router.get("/preview", (req, res) => {
  try {
    const ctx = getContext();
    const industries = Array.isArray(ctx.ctx_audience_industries)
      ? ctx.ctx_audience_industries.join(", ")
      : ctx.ctx_audience_industries;
    const geos = Array.isArray(ctx.ctx_audience_geographies)
      ? ctx.ctx_audience_geographies.join(", ")
      : ctx.ctx_audience_geographies;
    const excluded = Array.isArray(ctx.ctx_audience_exclude_industries)
      ? ctx.ctx_audience_exclude_industries.join(", ")
      : ctx.ctx_audience_exclude_industries;
    const w = ctx.ctx_audience_scoring_weights || {
      business_type: 30,
      location: 20,
      business_size: 20,
      completeness: 15,
      recency: 15,
    };
    const painPoints = Array.isArray(ctx.ctx_product_pain_points)
      ? ctx.ctx_product_pain_points
      : [];
    const themes = Array.isArray(ctx.ctx_content_post_themes)
      ? ctx.ctx_content_post_themes.join(", ")
      : "";
    const hashtagSets = ctx.ctx_content_hashtag_sets || {};
    const igHashtags = Array.isArray(hashtagSets.instagram)
      ? hashtagSets.instagram
          .slice(0, 5)
          .map((h) => `#${h}`)
          .join(" ")
      : "";

    res.json({
      qualification: `You are a lead qualification specialist for ${ctx.ctx_biz_name}.
Company: ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name} — ${ctx.ctx_product_tagline}

Ideal customer: ${ctx.ctx_audience_ideal_profile}

Scoring factors:
- Business type (${industries}; exclude: ${excluded}): ${w.business_type} pts
- Location (${geos}): ${w.location} pts
- Business size: ${w.business_size} pts
- Profile completeness: ${w.completeness} pts
- Activity recency: ${w.recency} pts`,

      messages: `Template variables:
{{product}}         → ${ctx.ctx_product_name}
{{product_tagline}} → ${ctx.ctx_product_tagline}
{{pain_point}}      → ${painPoints[0] || ""}
{{value_prop}}      → ${ctx.ctx_product_value_prop}
{{sender_name}}     → ${ctx.ctx_sender_name}
{{sign_off}}        → ${ctx.ctx_sender_sign_off}
{{cta}}             → ${ctx.ctx_content_cta}
{{biz_name}}        → ${ctx.ctx_biz_name}`,

      caption: `Write a social media caption for [platform] about: [topic]
Company: ${ctx.ctx_biz_name} — ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name} — ${ctx.ctx_product_tagline}
Tone: ${ctx.ctx_content_tone}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${Array.isArray(ctx.ctx_audience_geographies) ? ctx.ctx_audience_geographies[0] : ""}
CTA: ${ctx.ctx_content_cta}
Hashtags: ${igHashtags}`,

      image: `You are a creative director for ${ctx.ctx_biz_name}, ${ctx.ctx_biz_description}
Topic: [topic]
Brand themes: ${themes}
Visual style: ${ctx.ctx_content_image_style}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${Array.isArray(ctx.ctx_audience_geographies) ? ctx.ctx_audience_geographies[0] : ""}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

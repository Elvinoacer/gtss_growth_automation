/**
 * qualificationService/promptBuilder.js
 *
 * Builds the Gemini prompt that scores a single lead from 0-100 based on
 * its likelihood of becoming a paying client. The prompt is parameterized
 * by the project-level context (ctx_biz_name, ctx_audience_*) loaded via
 * contextService.getContext() — so updating the context in Settings
 * changes the prompt for every subsequent scoring run.
 *
 * Exports:
 *   - buildPrompt(lead): string  — the full prompt text for the given lead
 *
 * The prompt explicitly asks Gemini to respond with ONLY valid JSON in
 * the shape `{ score, reason, factors: { business_type, location,
 * business_size, completeness, recency } }` so the scorer can parse it
 * with parseGeminiJsonObject.
 *
 * Path notes: the original file used `require("./contextService")` for
 * the sibling service — from this split file that becomes
 * `require("../contextService")`.
 */

const { getContext } = require("../contextService");

function buildPrompt(lead) {
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
  const weights = ctx.ctx_audience_scoring_weights || {
    business_type: 30,
    location: 20,
    business_size: 20,
    completeness: 15,
    recency: 15,
  };

  return `You are a lead qualification specialist for ${ctx.ctx_biz_name}.
Company description: ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name} - ${ctx.ctx_product_tagline}

Ideal customer: ${ctx.ctx_audience_ideal_profile}

Score this lead from 0 to 100 based on likelihood to become a paying client.

Scoring factors:
- Business type match (${industries} = high score; ${excluded} = low): ${weights.business_type} points
- Location (${geos} = high; outside target region = low): ${weights.location} points
- Business size signals (has website, company listed, professional profile = high): ${weights.business_size} points
- Profile completeness (full profile = high; empty = low): ${weights.completeness} points
- Activity recency (recent posts/activity = high): ${weights.recency} points

Lead data:
Name: ${lead.name || "N/A"}
Role: ${lead.role || "N/A"}
Company: ${lead.company || "N/A"}
Location: ${lead.location || "N/A"}
Website: ${lead.website || "N/A"}
Platform: ${lead.platform || "N/A"}

Respond ONLY with valid JSON, no markdown, no preamble:
{"score": 72, "reason": "Brief reason here.", "factors": {"business_type": 25, "location": 18, "business_size": 15, "completeness": 8, "recency": 6}}`;
}

module.exports = { buildPrompt };

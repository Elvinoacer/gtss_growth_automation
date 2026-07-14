/**
 * messageService/generateViaAI.js
 *
 * AI-driven outreach message generation via Gemini (API key first, Gemini
 * Web fallback — both handled inside callGeminiText).
 *
 * Builds a per-platform prompt using the lead's profile + product context,
 * calls Gemini via callGeminiText, and inserts two A/B variants (both the
 * same AI-generated body — the variant distinction is preserved for
 * backward-compat with the review UI but the body is identical because the
 * prompt asks for a single best message).
 *
 * Pre-flight: if neither GEMINI_API_KEY nor any CDP endpoint is configured,
 * short-circuit to generateFromTemplate so the pipeline keeps moving and
 * tests don't hang trying to launch a browser that doesn't exist.
 *
 * On any AI failure, falls back to generateFromTemplate so the pipeline
 * doesn't deadlock when Gemini is rate-limited or the Web session is
 * unavailable. The fallback rows are stamped generated_by='template-fallback'.
 *
 * Returns { variantA: { id, body }, variantB: { id, body } }.
 */

const { getDb } = require("../../db/database");
const { getContext } = require("../contextService");
const { getPrimaryPlatform } = require("../platformCatalog");
const { callGeminiText, unwrapGeminiText } = require("../aiService");
const logger = require("../../utils/logger");
const {
  getCharLimit,
  extractPainPoint,
  stripCodeFences,
} = require("./templates");
const { generateFromTemplate } = require("./generateFromTemplate");

/**
 * Generate outreach DMs via Gemini (API key first, Gemini Web fallback).
 *
 * @param {Object} lead - Lead row from DB
 * @returns {Promise<{variantA: {id, body}, variantB: {id, body}}>}
 */
async function generateViaAI(lead) {
  const db = getDb();
  const ctx = getContext();
  const resolvedPlatform = lead.platform || getPrimaryPlatform();
  const messageType = resolvedPlatform === "linkedin" ? "connect" : "dm";
  const limit = getCharLimit(resolvedPlatform, messageType);
  const painPoints = Array.isArray(ctx.ctx_product_pain_points)
    ? ctx.ctx_product_pain_points
    : [];
  const geographies = Array.isArray(ctx.ctx_audience_geographies)
    ? ctx.ctx_audience_geographies
    : [];

  // ── Pre-flight: skip AI when no Gemini source is available ─────────────
  // If neither the Gemini API key nor a shared Chrome CDP endpoint is
  // configured, the AI path will hang trying to launch a browser that
  // doesn't exist (or fail immediately and fall back anyway). Short-circuit
  // to the template path so the pipeline keeps moving and tests don't hang.
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const hasCdp = Boolean(
    process.env.GEMINI_CDP_ENDPOINT ||
      process.env.CDP_ENDPOINT ||
      process.env.LINKEDIN_CDP_ENDPOINT ||
      process.env.INSTAGRAM_CDP_ENDPOINT ||
      process.env.FACEBOOK_CDP_ENDPOINT ||
      process.env.X_CDP_ENDPOINT,
  );
  if (!hasApiKey && !hasCdp) {
    logger.info("MESSAGES", "Skipping AI message generation — no GEMINI_API_KEY and no CDP endpoint; using template");
    const result = generateFromTemplate(lead);
    try {
      db.prepare(
        `UPDATE messages SET generated_by = 'template-fallback'
         WHERE id IN (?, ?)`,
      ).run(result.variantA.id, result.variantB.id);
    } catch (_) {}
    return result;
  }

  const prompt = `Write a short, genuine outreach ${messageType === "connect" ? "connection note" : "direct message"} for ${resolvedPlatform}.
Lead name: ${lead.name || "there"}
Lead role: ${lead.role || "unknown"}
Lead company: ${lead.company || "their business"}
Lead location: ${lead.location || geographies[0] || "Kenya"}
Product: ${ctx.ctx_product_name} — ${ctx.ctx_product_tagline}
Value proposition: ${ctx.ctx_product_value_prop}
Relevant pain point: ${extractPainPoint(lead.score_reason, painPoints)}
Sender: ${ctx.ctx_sender_name}
Sign-off: ${ctx.ctx_sender_sign_off}
Call to action: ${ctx.ctx_content_cta}

Rules:
- Max ${limit} characters including spaces.
- Plain text only, no markdown, no emojis unless they fit the tone naturally.
- Open with the lead's first name, end with the sign-off.
- Be specific about the pain point — don't be generic.
- One clear CTA, low friction.
Return ONLY the message body, no explanations or quotes.`;

  try {
    const generation = await callGeminiText(prompt, { timeoutMs: 25_000 });
    const raw = unwrapGeminiText(generation);
    let body = stripCodeFences(raw).replace(/^["']|["']$/g, "");
    if (body.length > limit) body = body.slice(0, limit);

    logger.db("info", "outreach", "message_ai", "AI outreach message generated", {
      leadId: lead.id,
      platform: resolvedPlatform,
      source: generation.source || "unknown",
      model: generation.model,
    });

    const insertStmt = db.prepare(
      `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, generated_at)
       VALUES (?, ?, ?, ?, 'pending', 'ai', CURRENT_TIMESTAMP)`,
    );
    const resultA = insertStmt.run(lead.id, resolvedPlatform, body, "A");
    const resultB = insertStmt.run(lead.id, resolvedPlatform, body, "B");
    return {
      variantA: { id: resultA.lastInsertRowid, body },
      variantB: { id: resultB.lastInsertRowid, body },
    };
  } catch (err) {
    logger.warn("MESSAGES", `AI message generation failed for lead ${lead.id}, falling back to template`, {
      error: err.message,
    });
    // Fall back to template so the pipeline keeps moving. The rows are
    // stamped 'template-fallback' so the review UI can show the user that
    // AI wasn't actually used for this lead.
    const result = generateFromTemplate(lead);
    // Re-stamp the rows so the user can see they came from the fallback path.
    try {
      db.prepare(
        `UPDATE messages SET generated_by = 'template-fallback'
         WHERE id IN (?, ?)`,
      ).run(result.variantA.id, result.variantB.id);
    } catch (_) {}
    return result;
  }
}

module.exports = { generateViaAI };

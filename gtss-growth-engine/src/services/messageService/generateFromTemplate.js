/**
 * messageService/generateFromTemplate.js
 *
 * Template-based fallback message generation. Both A and B variants use
 * the same canonical template (personalised with lead name only — no AI).
 *
 * Used directly when MESSAGE_GENERATION_SOURCE === 'template', and as the
 * fallback path inside generateViaAI when Gemini is rate-limited or the
 * Web session is unavailable (the fallback rows are stamped
 * generated_by='template-fallback' by the caller so the review UI can
 * show the user that AI wasn't actually used for this lead).
 *
 * Returns { variantA: { id, body }, variantB: { id, body } } — both
 * variants have the SAME body (the variant distinction is preserved for
 * backward-compat with the review UI, but the body is identical because
 * the template path doesn't try to generate two different messages).
 */

const { getDb } = require("../../db/database");
const { getContext } = require("../contextService");
const { getPrimaryPlatform } = require("../platformCatalog");
const {
  getCharLimit,
  getTemplate,
  fillTemplate,
  getFirstName,
  extractPainPoint,
  sanitizeOutreachBody,
} = require("./templates");

/**
 * Generate messages from the canonical template.
 * Both variants A and B use the same template - personalised with lead name only.
 * No AI generation is used for outreach DMs.
 *
 * @param {Object} lead - Lead record from DB
 * @returns {{variantA: {id: number, body: string}, variantB: {id: number, body: string}}}
 */
function generateFromTemplate(lead) {
  const db = getDb();
  const ctx = getContext();
  const resolvedPlatform = lead.platform || getPrimaryPlatform();
  const messageType = resolvedPlatform === "linkedin" ? "connect" : "dm";
  const template = getTemplate(resolvedPlatform, messageType);

  const painPoints = Array.isArray(ctx.ctx_product_pain_points)
    ? ctx.ctx_product_pain_points
    : [];
  const geographies = Array.isArray(ctx.ctx_audience_geographies)
    ? ctx.ctx_audience_geographies
    : [];

  const templateVars = {
    lead_name: getFirstName(lead.name),
    role: lead.role || "",
    company: lead.company || "your business",
    location: lead.location || geographies[0] || "Kenya",
    product: ctx.ctx_product_name,
    product_tagline: ctx.ctx_product_tagline,
    pain_point: extractPainPoint(lead.score_reason, painPoints),
    value_prop: ctx.ctx_product_value_prop,
    sender_name: ctx.ctx_sender_name,
    sign_off: ctx.ctx_sender_sign_off,
    cta: ctx.ctx_content_cta,
    biz_name: ctx.ctx_biz_name,
  };

  // Both variants use the same canonical template
  let body = template
    ? fillTemplate(template, templateVars)
    : `Hi ${templateVars.lead_name},\n\n${ctx.ctx_product_value_prop}\n\nWould love to connect!\n\n${ctx.ctx_sender_sign_off}`;

  // Strip any leftover placeholder tokens (e.g. a template that still has [link])
  // and optionally substitute the real business website.
  body = sanitizeOutreachBody(body, {
    websiteUrl: ctx.ctx_biz_website || null,
  });

  // Strict character limit enforcement
  const limit = getCharLimit(resolvedPlatform, messageType);
  if (body.length > limit) {
    body = body.slice(0, limit);
  }

  const insertStmt = db.prepare(
    `INSERT INTO messages (lead_id, platform, body, variant, status, generated_by, generated_at)
     VALUES (?, ?, ?, ?, 'pending', 'template', CURRENT_TIMESTAMP)`,
  );

  const resultA = insertStmt.run(lead.id, resolvedPlatform, body, "A");
  const resultB = insertStmt.run(lead.id, resolvedPlatform, body, "B");

  return {
    variantA: { id: resultA.lastInsertRowid, body },
    variantB: { id: resultB.lastInsertRowid, body },
    generatedBy: "template",
  };
}

module.exports = { generateFromTemplate };

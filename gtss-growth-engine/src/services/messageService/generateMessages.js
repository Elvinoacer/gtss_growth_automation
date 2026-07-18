/**
 * messageService/generateMessages.js
 *
 * Single-lead message dispatcher. Reads the message_generation_source
 * setting (DB: 'message_generation_source', env: MESSAGE_GENERATION_SOURCE,
 * default 'ai') and routes to generateViaAI or generateFromTemplate.
 *
 * The user explicitly requested that AI be the default for the full
 * lead-discovery pipeline, with the option to switch to manual templates.
 *
 * _productPitch and _tone params are deprecated but kept for backward-
 * compat with older callers (they're ignored — the prompt is now built
 * from the context service's ctx_product_* fields).
 */

const { getDb } = require("../../db/database");
const { messageGenerationSource } = require("../../config/pipelineConfig");
const { generateFromTemplate } = require("./generateFromTemplate");
const { generateViaAI } = require("./generateViaAI");

/**
 * Generate outreach messages for a single lead.
 *
 * @param {number} leadId
 * @param {string} platform - optional override; falls back to lead.platform
 * @param {string} _productPitch - deprecated, kept for backward-compat
 * @param {string} _tone - deprecated, kept for backward-compat
 * @param {{ forceAi?: boolean, onProgress?: Function }} [options]
 *   forceAi — always use Gemini cascade (API → Web → template), even when
 *             Settings is set to Template mode. Used by Retry Fallbacks.
 * @returns {Promise<{variantA: {id, body}, variantB: {id, body}, generatedBy?: string}>}
 */
async function generateMessages(
  leadId,
  platform,
  _productPitch,
  _tone,
  options = {},
) {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (platform && lead.platform !== platform) {
    lead.platform = platform;
  }

  const forceAi = options && options.forceAi === true;
  const source = messageGenerationSource();
  if (!forceAi && source === "template") {
    return generateFromTemplate(lead);
  }
  return generateViaAI(lead, {
    onProgress: options && options.onProgress,
  });
}

module.exports = { generateMessages };

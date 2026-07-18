/**
 * messageService/retireTemplateMessages.js
 *
 * When a real Gemini (API or Web) message is created for a lead, any
 * leftover template / template-fallback drafts must leave the send path.
 * Otherwise the Automation queue can still approve or pin a generic
 * fallback that was created during an earlier Gemini outage.
 *
 * Templates remain available as emergency drafts only; they are not
 * auto-sent once a real AI body exists for the same lead/platform.
 */

const AI_GENERATED_BY = new Set(["ai", "ai-web"]);
const TEMPLATE_GENERATED_BY = new Set(["template", "template-fallback"]);

function isAiGeneratedBy(value) {
  return AI_GENERATED_BY.has(String(value || "").trim().toLowerCase());
}

function isTemplateGeneratedBy(value) {
  return TEMPLATE_GENERATED_BY.has(String(value || "").trim().toLowerCase());
}

/**
 * Skip pending/approved/draft template rows for a lead so AI messages own
 * the outbound queue for that platform.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ leadId: number, platform?: string|null, keepIds?: number[] }} opts
 * @returns {number} rows retired
 */
function retireTemplateMessages(db, { leadId, platform = null, keepIds = [] } = {}) {
  if (!db || leadId == null) return 0;

  const keep = (Array.isArray(keepIds) ? keepIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const keepClause =
    keep.length > 0 ? `AND id NOT IN (${keep.map(() => "?").join(",")})` : "";

  const result = db
    .prepare(
      `UPDATE messages
       SET status = 'skipped',
           last_error = COALESCE(last_error, 'Superseded by AI-generated message')
       WHERE lead_id = ?
         AND COALESCE(platform, '') = COALESCE(?, '')
         AND COALESCE(is_follow_up, 0) = 0
         AND status IN ('pending', 'approved', 'draft')
         AND LOWER(TRIM(COALESCE(generated_by, ''))) IN ('template', 'template-fallback')
         ${keepClause}`,
    )
    .run(leadId, platform || null, ...keep);

  return result.changes || 0;
}

/**
 * True when a lead already has a real AI draft/approval (not template).
 * Used by Generate All / pipeline stage so we re-try leads stuck on fallback.
 */
function hasNonTemplateMessage(db, leadId) {
  if (!db || leadId == null) return false;
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM messages
       WHERE lead_id = ?
         AND status IN ('pending', 'approved')
         AND COALESCE(is_follow_up, 0) = 0
         AND COALESCE(generated_by, '') NOT IN ('template', 'template-fallback')
       LIMIT 1`,
    )
    .get(leadId);
  return Boolean(row);
}

/**
 * SQL fragment: lead has no real AI pending/approved outreach yet.
 * Template-only rows do NOT count — those leads should be re-generated.
 */
function needsAiMessageSql(leadAlias = "l") {
  // "Needs AI" = no real Gemini body (api or web) yet. Template stamps
  // and blank generated_by do not satisfy this.
  return `NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.lead_id = ${leadAlias}.id
      AND m.status IN ('pending', 'approved')
      AND COALESCE(m.is_follow_up, 0) = 0
      AND LOWER(TRIM(COALESCE(m.generated_by, ''))) IN ('ai', 'ai-web')
  )`;
}

/**
 * Match template / template-fallback stamps case-insensitively and with
 * trim — older rows or manual edits may not be exact lowercase.
 */
function isTemplateGeneratedBySql(alias = "m") {
  return `LOWER(TRIM(COALESCE(${alias}.generated_by, ''))) IN ('template', 'template-fallback')`;
}

/**
 * SQL fragment: lead currently has at least one unsent template /
 * template-fallback draft (the rows shown as "Template" / "Template
 * fallback" in the UI).
 */
function hasTemplateFallbackSql(leadAlias = "l") {
  return `EXISTS (
    SELECT 1 FROM messages m
    WHERE m.lead_id = ${leadAlias}.id
      AND m.status IN ('pending', 'approved', 'draft')
      AND COALESCE(m.is_follow_up, 0) = 0
      AND ${isTemplateGeneratedBySql("m")}
  )`;
}

/**
 * Leads with unsent template / template-fallback drafts.
 * Not limited to status='qualified' — Generate All misses leads that already
 * left the qualified stage with only fallback drafts.
 *
 * Includes leads that still show template drafts even if a sibling AI row
 * exists (those templates get retired on retry). Prefer leads with no AI
 * body first so Gemini is re-run where it matters most.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {object[]} lead rows
 */
function listFallbackLeads(db) {
  if (!db) return [];
  return db
    .prepare(
      `SELECT l.*
       FROM leads l
       WHERE ${hasTemplateFallbackSql("l")}
         AND COALESCE(l.status, '') NOT IN (
           'replied', 'meeting_booked', 'converted', 'deprioritized'
         )
       ORDER BY
         CASE WHEN ${needsAiMessageSql("l")} THEN 0 ELSE 1 END,
         COALESCE(l.lead_score, 0) DESC,
         l.id ASC`,
    )
    .all();
}

/**
 * Count distinct leads that would be included in Retry All Fallbacks.
 */
function countFallbackLeads(db) {
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM leads l
       WHERE ${hasTemplateFallbackSql("l")}
         AND COALESCE(l.status, '') NOT IN (
           'replied', 'meeting_booked', 'converted', 'deprioritized'
         )`,
    )
    .get();
  return Number(row?.c || 0);
}

/**
 * Count unsent template / template-fallback message rows (for stats badge).
 * Treats NULL/empty generated_by that is still a plain template path as
 * non-AI only when explicitly stamped — null defaults are left alone.
 */
function countFallbackMessages(db) {
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
       WHERE m.status IN ('pending', 'approved', 'draft')
         AND COALESCE(m.is_follow_up, 0) = 0
         AND ${isTemplateGeneratedBySql("m")}`,
    )
    .get();
  return Number(row?.c || 0);
}

/**
 * True when every pending row for this lead is a template fallback
 * (or there are none). Used to decide whether cached drafts may be returned.
 */
function onlyHasTemplatePending(db, leadId) {
  if (!db || leadId == null) return true;
  const rows = db
    .prepare(
      `SELECT generated_by FROM messages
       WHERE lead_id = ?
         AND status = 'pending'
         AND COALESCE(is_follow_up, 0) = 0`,
    )
    .all(leadId);
  if (rows.length === 0) return true;
  return rows.every((row) => isTemplateGeneratedBy(row.generated_by));
}

module.exports = {
  AI_GENERATED_BY,
  TEMPLATE_GENERATED_BY,
  isAiGeneratedBy,
  isTemplateGeneratedBy,
  isTemplateGeneratedBySql,
  retireTemplateMessages,
  hasNonTemplateMessage,
  needsAiMessageSql,
  hasTemplateFallbackSql,
  listFallbackLeads,
  countFallbackLeads,
  countFallbackMessages,
  onlyHasTemplatePending,
};

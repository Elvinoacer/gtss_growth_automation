/**
 * Shared safety policy for outbound outreach messages.
 *
 * Template and template-fallback rows are useful drafts, but they must never
 * be sent automatically. Only a founder can explicitly promote one of those
 * drafts — and only when no Gemini (API or Web) approved body exists for the
 * same lead/platform. Gemini rows (`ai` / `ai-web`) remain eligible for
 * auto-send once approved.
 *
 * Keeping this rule here prevents the Automation page, campaign DM queue,
 * and send pipeline from drifting apart.
 */

function sendableApprovedMessageClause(alias = "m") {
  return `(
    (
      ${alias}.approved_by = 'founder'
      AND COALESCE(${alias}.generated_by, '') IN ('template', 'template-fallback')
      AND NOT EXISTS (
        SELECT 1 FROM messages ai
        WHERE ai.lead_id = ${alias}.lead_id
          AND COALESCE(ai.platform, '') = COALESCE(${alias}.platform, '')
          AND COALESCE(ai.is_follow_up, 0) = COALESCE(${alias}.is_follow_up, 0)
          AND ai.status = 'approved'
          AND COALESCE(ai.generated_by, '') IN ('ai', 'ai-web')
      )
    )
    OR COALESCE(${alias}.generated_by, '') NOT IN ('template', 'template-fallback')
  )`;
}

function approvedMessagePrioritySql(alias = "m") {
  return `
    CASE
      -- Gemini bodies always beat template drafts, even if the template
      -- was founder-approved earlier (the AI message is the one we worked
      -- to generate for this lead).
      WHEN COALESCE(${alias}.generated_by, '') IN ('ai', 'ai-web') THEN 0
      WHEN ${alias}.approved_by = 'founder'
        AND COALESCE(${alias}.generated_by, '') NOT IN ('template', 'template-fallback')
        THEN 1
      WHEN ${alias}.approved_by = 'founder' THEN 2
      WHEN ${alias}.generated_by = 'template' THEN 4
      WHEN ${alias}.generated_by = 'template-fallback' THEN 5
      ELSE 3
    END,
    ${alias}.approved_at DESC,
    ${alias}.id DESC`;
}

function getPreferredApprovedMessage(db, { leadId, platform, isFollowUp = false }) {
  return db
    .prepare(
      `SELECT id, body, lead_id, platform, generated_by, approved_by
       FROM messages m
       WHERE m.lead_id = ?
         AND m.platform = ?
         AND COALESCE(m.is_follow_up, 0) = ?
         AND m.status = 'approved'
         AND ${sendableApprovedMessageClause("m")}
       ORDER BY ${approvedMessagePrioritySql("m")}
       LIMIT 1`,
    )
    .get(leadId, platform, isFollowUp ? 1 : 0);
}

module.exports = {
  sendableApprovedMessageClause,
  approvedMessagePrioritySql,
  getPreferredApprovedMessage,
};

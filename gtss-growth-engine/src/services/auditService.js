const { getDb } = require("../db/database");

function serializeDetails(details) {
  if (!details || typeof details !== "object") return null;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return JSON.stringify({ error: "Failed to serialize audit details" });
  }
}

function logActivity({
  activityType,
  entityType = null,
  entityId = null,
  platform = null,
  actor = "system",
  status = null,
  summary,
  details = {},
}) {
  if (!activityType || !summary) return false;

  try {
    getDb()
      .prepare(
        `INSERT INTO audit_log
          (activity_type, entity_type, entity_id, platform, actor, status, summary, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(activityType),
        entityType ? String(entityType) : null,
        entityId !== null && entityId !== undefined ? String(entityId) : null,
        platform ? String(platform) : null,
        actor ? String(actor) : "system",
        status ? String(status) : null,
        String(summary),
        serializeDetails(details),
      );
    return true;
  } catch (error) {
    console.warn("[AUDIT] Failed to write audit log:", error.message);
    return false;
  }
}

module.exports = {
  logActivity,
};

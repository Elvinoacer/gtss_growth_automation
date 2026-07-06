/**
 * pipelineCheckpoint.js — Per-stage checkpoint persistence
 *
 * Lets long-running automations save progress per stage so that a restart
 * can resume from the last successful checkpoint instead of redoing the
 * whole pipeline.
 *
 * Public API:
 *   saveCheckpoint({ executionId, pipelineId, stage, status, payload, error, durationMs, attempt })
 *   getCheckpoints(executionId)
 *   getLatestCompleted(executionId)
 *   getResumeStage(executionId, orderedStages)
 *   hasCheckpoint(executionId, stage)
 *   clearCheckpoints(executionId)
 */

const { getDb } = require("../db/database");

const VALID_STATUSES = new Set(["completed", "failed", "skipped", "running"]);

function safeJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ error: "Failed to serialize checkpoint payload" });
  }
}

/**
 * Save a checkpoint for a specific stage of a specific execution.
 * If a checkpoint already exists for the same (execution_id, stage), it is
 * updated in place rather than duplicated.
 */
function saveCheckpoint({
  executionId,
  pipelineId,
  stage,
  status = "completed",
  payload = null,
  error = null,
  durationMs = null,
  attempt = 1,
}) {
  if (!executionId || !pipelineId || !stage) return null;
  const normalizedStatus = VALID_STATUSES.has(status) ? status : "completed";

  const db = getDb();
  const existing = db
    .prepare(
      "SELECT id FROM pipeline_checkpoints WHERE execution_id = ? AND stage = ?",
    )
    .get(String(executionId), String(stage));

  const payloadJson = safeJson(payload);
  const errorMessage = error ? String(error.message || error) : null;
  const duration =
    durationMs !== undefined && durationMs !== null ? Number(durationMs) : null;
  const attemptNum = Math.max(1, Number(attempt) || 1);

  if (existing) {
    db.prepare(
      `UPDATE pipeline_checkpoints
       SET status = ?, payload_json = ?, error_message = ?, duration_ms = ?, attempt = ?, created_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(
      normalizedStatus,
      payloadJson,
      errorMessage,
      duration,
      attemptNum,
      existing.id,
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO pipeline_checkpoints
        (execution_id, pipeline_id, stage, status, attempt, payload_json, error_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(executionId),
      String(pipelineId),
      String(stage),
      normalizedStatus,
      attemptNum,
      payloadJson,
      errorMessage,
      duration,
    );
  return result.lastInsertRowid;
}

/**
 * List all checkpoints for an execution, in insertion order.
 */
function getCheckpoints(executionId) {
  if (!executionId) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM pipeline_checkpoints
       WHERE execution_id = ?
       ORDER BY id ASC`,
    )
    .all(String(executionId));

  return rows.map((row) => {
    let payload = null;
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : null;
    } catch (_) {}
    return {
      id: row.id,
      execution_id: row.execution_id,
      pipeline_id: row.pipeline_id,
      stage: row.stage,
      status: row.status,
      attempt: row.attempt,
      payload,
      error_message: row.error_message,
      duration_ms: row.duration_ms,
      created_at: row.created_at,
    };
  });
}

/**
 * Get the latest 'completed' checkpoint for an execution.
 */
function getLatestCompleted(executionId) {
  if (!executionId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM pipeline_checkpoints
       WHERE execution_id = ? AND status = 'completed'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(String(executionId));
  if (!row) return null;

  let payload = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch (_) {}
  return {
    id: row.id,
    execution_id: row.execution_id,
    pipeline_id: row.pipeline_id,
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    payload,
    error_message: row.error_message,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

/**
 * Determine which stage to resume from, given the ordered list of stages
 * defined for this pipeline.
 *
 * Rules:
 *   - If there are no completed checkpoints → return the first stage.
 *   - If all stages have a 'completed' checkpoint → return null (pipeline is fully done).
 *   - Otherwise → return the first stage that does NOT have a 'completed' checkpoint.
 *
 * @param {string} executionId
 * @param {string[]} orderedStages - e.g. ['discovery', 'qualification', 'messages', 'send']
 * @returns {string|null}
 */
function getResumeStage(executionId, orderedStages = []) {
  if (!executionId || !Array.isArray(orderedStages) || orderedStages.length === 0) {
    return null;
  }
  const db = getDb();
  const completed = new Set(
    db
      .prepare(
        `SELECT DISTINCT stage FROM pipeline_checkpoints
         WHERE execution_id = ? AND status = 'completed'`,
      )
      .all(String(executionId))
      .map((r) => r.stage),
  );

  for (const stage of orderedStages) {
    if (!completed.has(stage)) return stage;
  }
  // All stages complete — nothing to resume
  return null;
}

/**
 * Has the given stage already been checkpointed (any status) for this execution?
 */
function hasCheckpoint(executionId, stage) {
  if (!executionId || !stage) return false;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT 1 FROM pipeline_checkpoints WHERE execution_id = ? AND stage = ? LIMIT 1",
    )
    .get(String(executionId), String(stage));
  return Boolean(row);
}

/**
 * Has the given stage already completed successfully?
 */
function isStageComplete(executionId, stage) {
  if (!executionId || !stage) return false;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT 1 FROM pipeline_checkpoints WHERE execution_id = ? AND stage = ? AND status = 'completed' LIMIT 1",
    )
    .get(String(executionId), String(stage));
  return Boolean(row);
}

/**
 * Wipe all checkpoints for an execution (used when restarting from scratch).
 */
function clearCheckpoints(executionId) {
  if (!executionId) return 0;
  const db = getDb();
  const result = db
    .prepare("DELETE FROM pipeline_checkpoints WHERE execution_id = ?")
    .run(String(executionId));
  return result.changes || 0;
}

/**
 * Update the payload of an existing checkpoint (e.g. to add a post_id reference
 * discovered later in the same stage).
 */
function updatePayload(executionId, stage, payload) {
  if (!executionId || !stage) return false;
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE pipeline_checkpoints SET payload_json = ? WHERE execution_id = ? AND stage = ?",
    )
    .run(safeJson(payload), String(executionId), String(stage));
  return result.changes > 0;
}

module.exports = {
  saveCheckpoint,
  getCheckpoints,
  getLatestCompleted,
  getResumeStage,
  hasCheckpoint,
  isStageComplete,
  clearCheckpoints,
  updatePayload,
};

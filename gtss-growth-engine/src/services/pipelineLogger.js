/**
 * pipelineLogger.js — Structured, searchable pipeline logger
 *
 * Writes to the `pipeline_logs` table (added in the pipelines overhaul).
 * Also fans out to:
 *   - console (via existing utils/logger)
 *   - legacy `pipeline_events` table (for backward compat with monitoring page)
 *   - Socket.IO broadcast `pipeline:log` for live tail
 *
 * Public API:
 *   log(entry)                          - write a single log entry
 *   logExecution(pipelineId, execId, level, stage, message, opts)
 *   query({ pipelineId, executionId, level, stage, search, since, until, limit, offset, source, browserEvent })
 *   streamTail(executionId, limit)
 */

const { getDb } = require("../db/database");
const logger = require("../utils/logger");

const VALID_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "retry",
  "success",
]);

function normalizeLevel(level) {
  const candidate = String(level || "info").toLowerCase();
  if (VALID_LEVELS.has(candidate)) return candidate;
  if (candidate === "warning") return "warn";
  if (candidate === "fatal") return "error";
  return "info";
}

function safeJsonStringify(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    // If it already looks like JSON, keep as-is; otherwise wrap
    try {
      JSON.parse(value);
      return value;
    } catch (_) {
      return JSON.stringify({ value });
    }
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ error: "Failed to serialize context" });
  }
}

function extractStackTrace(err) {
  if (!err) return null;
  if (typeof err === "string") return null;
  if (err instanceof Error) return err.stack || null;
  if (typeof err === "object" && err.stack) return String(err.stack);
  return null;
}

function extractMessage(err) {
  if (!err) return null;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err.message) return String(err.message);
  return String(err);
}

/**
 * Write a structured log entry.
 *
 * @param {Object} entry
 * @param {string} entry.pipelineId     - 'outreach' | 'content' | 'dm_check'
 * @param {string} [entry.executionId]  - UUID from pipeline_executions.id
 * @param {string} [entry.stage]        - e.g. 'discovery', 'image_gen', 'publish'
 * @param {string} entry.level          - debug|info|warn|error|retry|success
 * @param {string} entry.message
 * @param {Error|Object|string} [entry.error]    - error object or message
 * @param {Object} [entry.context]      - arbitrary structured context
 * @param {string} [entry.browserEvent] - 'navigation' | 'click' | 'timeout' | 'captcha' | 'login'
 * @param {number} [entry.retryAttempt]
 * @param {string} [entry.source]       - 'system' | 'browser' | 'user' | 'scheduler'
 */
function log(entry = {}) {
  const pipelineId = String(entry.pipelineId || "").trim();
  const message = String(entry.message || entry.messageText || "").trim();
  if (!pipelineId || !message) return null;

  const level = normalizeLevel(entry.level);
  const executionId =
    entry.executionId !== undefined && entry.executionId !== null
      ? String(entry.executionId)
      : null;
  const stage = entry.stage ? String(entry.stage) : null;
  const stackTrace = entry.stackTrace || extractStackTrace(entry.error);
  const errorMessage = entry.errorMessage || extractMessage(entry.error);
  const contextJson = safeJsonStringify(entry.context || entry.details);
  const browserEvent = entry.browserEvent ? String(entry.browserEvent) : null;
  const retryAttempt =
    entry.retryAttempt !== undefined && entry.retryAttempt !== null
      ? Number(entry.retryAttempt)
      : null;
  const source = entry.source ? String(entry.source) : "system";

  // Also write the message to the legacy console logger for visibility.
  const consoleMessage = `[${pipelineId}${
    executionId ? `:${executionId.slice(0, 8)}` : ""
  }${stage ? `/${stage}` : ""}] ${message}${errorMessage ? ` — ${errorMessage}` : ""}`;
  const consoleData = entry.context || (entry.error ? { error: errorMessage } : undefined);
  if (level === "error") logger.error("PIPELINE", consoleMessage, consoleData);
  else if (level === "warn") logger.warn("PIPELINE", consoleMessage, consoleData);
  else if (level === "retry") logger.info("PIPELINE", `[retry] ${consoleMessage}`, consoleData);
  else if (level === "debug") logger.debug("PIPELINE", consoleMessage, consoleData);
  else logger.info("PIPELINE", consoleMessage, consoleData);

  let logId = null;
  try {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO pipeline_logs
          (pipeline_id, execution_id, stage, level, message, stack_trace,
           context_json, browser_event, retry_attempt, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pipelineId,
        executionId,
        stage,
        level,
        message,
        stackTrace,
        contextJson,
        browserEvent,
        retryAttempt,
        source,
      );
    logId = result.lastInsertRowid;

    // Mirror into legacy pipeline_events table for backward compat with the monitoring page
    try {
      const legacyContext = entry.context || {};
      db.prepare(
        `INSERT INTO pipeline_events
          (job_type, job_id, stage, level, message, context_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        pipelineId,
        executionId,
        stage,
        level === "success" ? "info" : level,
        message,
        safeJsonStringify({
          ...legacyContext,
          errorMessage,
          stackTrace,
          browserEvent,
          retryAttempt,
          source,
          executionId,
        }),
      );
    } catch (_) {}
  } catch (err) {
    console.error("[PIPELINE-LOGGER] Failed to write log entry:", err.message);
  }

  // Broadcast to live UI tail (best-effort)
  try {
    const { broadcast } = require("./socketService");
    broadcast("pipeline:log", {
      id: logId,
      pipeline_id: pipelineId,
      execution_id: executionId,
      stage,
      level,
      message,
      stack_trace: stackTrace,
      context: entry.context || null,
      browser_event: browserEvent,
      retry_attempt: retryAttempt,
      source,
      created_at: new Date().toISOString(),
    });
  } catch (_) {}

  return logId;
}

function logExecution(pipelineId, executionId, level, stage, message, opts = {}) {
  return log({
    pipelineId,
    executionId,
    level,
    stage,
    message,
    error: opts.error,
    context: opts.context,
    browserEvent: opts.browserEvent,
    retryAttempt: opts.retryAttempt,
    source: opts.source || "system",
  });
}

/**
 * Query structured pipeline logs with filters.
 *
 * @param {Object} filters
 * @param {string} [filters.pipelineId]
 * @param {string} [filters.executionId]
 * @param {string} [filters.level]         - exact match (info|warn|error|retry|success|debug)
 * @param {string|string[]} [filters.levels] - multiple levels (OR)
 * @param {string} [filters.stage]
 * @param {string} [filters.search]        - LIKE %search% on message
 * @param {string} [filters.since]         - ISO timestamp
 * @param {string} [filters.until]         - ISO timestamp
 * @param {string} [filters.source]
 * @param {string} [filters.browserEvent]
 * @param {number} [filters.limit=200]
 * @param {number} [filters.offset=0]
 * @returns {{ logs: Array, total: number }}
 */
function query(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.pipelineId) {
    where.push("pipeline_id = ?");
    params.push(String(filters.pipelineId));
  }
  if (filters.executionId) {
    where.push("execution_id = ?");
    params.push(String(filters.executionId));
  }
  if (filters.levels) {
    const levels = Array.isArray(filters.levels)
      ? filters.levels
      : String(filters.levels)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    if (levels.length > 0) {
      where.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
  } else if (filters.level) {
    where.push("level = ?");
    params.push(String(filters.level).toLowerCase());
  }
  if (filters.stage) {
    where.push("stage = ?");
    params.push(String(filters.stage));
  }
  if (filters.search) {
    where.push("message LIKE ?");
    params.push(`%${String(filters.search)}%`);
  }
  if (filters.since) {
    where.push("created_at >= ?");
    params.push(String(filters.since));
  }
  if (filters.until) {
    where.push("created_at <= ?");
    params.push(String(filters.until));
  }
  if (filters.source) {
    where.push("source = ?");
    params.push(String(filters.source));
  }
  if (filters.browserEvent) {
    where.push("browser_event = ?");
    params.push(String(filters.browserEvent));
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(Number(filters.limit) || 200, 5000));
  const offset = Math.max(0, Number(filters.offset) || 0);

  const rows = db
    .prepare(
      `SELECT * FROM pipeline_logs ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  let total = rows.length;
  if (rows.length === limit) {
    total =
      db
        .prepare(`SELECT COUNT(*) as c FROM pipeline_logs ${whereClause}`)
        .get(...params).c || 0;
  }

  return {
    logs: rows.map((row) => {
      let context = null;
      try {
        context = row.context_json ? JSON.parse(row.context_json) : null;
      } catch (_) {}
      return {
        id: row.id,
        pipeline_id: row.pipeline_id,
        execution_id: row.execution_id,
        stage: row.stage,
        level: row.level,
        message: row.message,
        stack_trace: row.stack_trace,
        context,
        browser_event: row.browser_event,
        retry_attempt: row.retry_attempt,
        source: row.source,
        created_at: row.created_at,
      };
    }),
    total,
  };
}

/**
 * Get the most recent logs for a specific execution (live tail).
 */
function streamTail(executionId, limit = 200) {
  return query({
    executionId,
    limit: Math.max(1, Math.min(Number(limit) || 200, 2000)),
  });
}

/**
 * Aggregate counts by level for a pipeline (or execution).
 * Useful for the "X errors / Y retries / Z info" summary chips.
 */
function countByLevel(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (filters.pipelineId) {
    where.push("pipeline_id = ?");
    params.push(String(filters.pipelineId));
  }
  if (filters.executionId) {
    where.push("execution_id = ?");
    params.push(String(filters.executionId));
  }
  if (filters.since) {
    where.push("created_at >= ?");
    params.push(String(filters.since));
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT level, COUNT(*) as count FROM pipeline_logs ${whereClause} GROUP BY level`,
    )
    .all(...params);

  const result = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    retry: 0,
    success: 0,
  };
  for (const row of rows) {
    if (result[row.level] !== undefined) result[row.level] = row.count;
  }
  result.total = Object.values(result).reduce((a, b) => a + b, 0);
  return result;
}

module.exports = {
  log,
  logExecution,
  query,
  streamTail,
  countByLevel,
  normalizeLevel,
};

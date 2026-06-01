const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const CURRENT_LEVEL =
  process.env.NODE_ENV === "production" ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;

function formatMessage(level, moduleName, message, data) {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${level}] [${moduleName}] ${message}`;
  if (data) {
    if (data instanceof Error) {
      logLine += ` ${data.stack}`;
    } else {
      logLine += ` ${JSON.stringify(data)}`;
    }
  }
  return logLine;
}

function normalizeArgs(moduleName, message, data) {
  if (typeof message === "undefined") {
    return {
      moduleName: "APP",
      message: moduleName,
      data: undefined,
    };
  }

  if (typeof message !== "string") {
    return {
      moduleName: "APP",
      message: moduleName,
      data: message,
    };
  }

  return { moduleName, message, data };
}

function log(level, moduleName, message, data) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const normalized = normalizeArgs(moduleName, message, data);
  const logLine = formatMessage(
    level,
    normalized.moduleName,
    normalized.message,
    normalized.data,
  );

  switch (level) {
    case "DEBUG":
    case "INFO":
      console.log(logLine);
      break;
    case "WARN":
      console.warn(logLine);
      break;
    case "ERROR":
      console.error(logLine);
      break;
  }
}

function normalizeDbLevel(level) {
  const candidate = String(level || "").toLowerCase();
  if (candidate === "warn" || candidate === "warning") return "warn";
  if (candidate === "error") return "error";
  if (candidate === "retry") return "retry";
  return "info";
}

function buildDbContext(contextObj) {
  if (!contextObj) return null;

  if (contextObj instanceof Error) {
    return {
      error: {
        message: contextObj.message,
        stack: contextObj.stack,
      },
    };
  }

  if (typeof contextObj === "object") {
    if (contextObj.error instanceof Error) {
      return {
        ...contextObj,
        error: {
          message: contextObj.error.message,
          stack: contextObj.error.stack,
        },
      };
    }
    return contextObj;
  }

  return { value: contextObj };
}

function logToDb(level, jobType, stage, message, contextObj) {
  if (!jobType || !message) return;

  const dbLevel = normalizeDbLevel(level);
  const context = buildDbContext(contextObj);
  const jobId =
    (context &&
      (context.jobId || context.job_id || context.runId || context.run_id)) ||
    null;
  let contextJson = null;
  if (context) {
    try {
      contextJson = JSON.stringify(context);
    } catch (_) {
      contextJson = JSON.stringify({ error: "Failed to serialize context" });
    }
  }

  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO pipeline_events (job_type, job_id, stage, level, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      String(jobType),
      jobId !== null && jobId !== undefined ? String(jobId) : null,
      stage ? String(stage) : null,
      dbLevel,
      String(message),
      contextJson,
    );
  } catch (err) {
    console.error("[LOGGER-DB] Failed to write monitoring event:", err.message);
  }
}

module.exports = {
  debug: (moduleName, message, data) => log("DEBUG", moduleName, message, data),
  info: (moduleName, message, data) => log("INFO", moduleName, message, data),
  warn: (moduleName, message, data) => log("WARN", moduleName, message, data),
  error: (moduleName, message, data) => log("ERROR", moduleName, message, data),
  log, // For generic use
  db: (level, jobType, stage, message, contextObj) =>
    logToDb(level, jobType, stage, message, contextObj),
};

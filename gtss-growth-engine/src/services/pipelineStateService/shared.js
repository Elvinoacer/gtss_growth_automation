/**
 * shared.js — Shared state, constants, and helpers for the pipeline-state
 * lifecycle service.
 *
 * Holds the in-memory flag maps that every other split file in this directory
 * mutates / reads:
 *   - STATES / VALID_STATES — the canonical state enum
 *   - ABORT_FLAGS  (Map<executionId, true>)       — set when a stop is requested
 *   - PAUSE_FLAGS  (Map<executionId, 'running'|'paused'>)
 *   - ACTIVE_EXECUTIONS (Map<pipelineId, executionId>) — single-instance lock
 *   - RUNNERS      (object<pipelineId, runnerFn>) — injected by pipeline modules
 *
 * Because these are Maps / a plain object, all split files that import them
 * share the SAME instance — mutations propagate natively across files (no
 * holder-object wrapper needed, since none of these is a primitive that gets
 * reassigned).
 *
 * Also exposes the small pure helpers (uuid, safeJson, parseJson, isValidState,
 * registerRunner) and the broadcastState() helper that lazily imports
 * socketService (lazy to avoid the require cycle between pipelineStateService
 * and socketService).
 */
"use strict";

const crypto = require("crypto");
const logger = require("../../utils/logger");

const STATES = Object.freeze({
  IDLE: "idle",
  SCHEDULED: "scheduled",
  RUNNING: "running",
  PAUSED: "paused",
  RESUMING: "resuming",
  STOPPING: "stopping",
  STOPPED: "stopped",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRYING: "retrying",
});

const VALID_STATES = new Set(Object.values(STATES));

// In-memory flag maps keyed by executionId
const ABORT_FLAGS = new Map(); // executionId → true
const PAUSE_FLAGS = new Map(); // executionId → 'running' | 'paused'

// Pipeline-level lock: pipelineId → executionId (the active execution)
const ACTIVE_EXECUTIONS = new Map();

// Runners injected by pipeline modules
const RUNNERS = {};

function registerRunner(pipelineId, runnerFn) {
  RUNNERS[pipelineId] = runnerFn;
}

function isValidState(state) {
  return VALID_STATES.has(String(state || "").toLowerCase());
}

function uuid() {
  return crypto.randomUUID();
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ error: "Failed to serialize" });
  }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

/**
 * Broadcast a pipeline state change over Socket.IO (best-effort). Lazily
 * imports socketService so we don't trigger its (heavy) require chain at
 * module-load time — and so we don't crash if socketService isn't ready
 * yet (e.g., during server boot before the HTTP server is up).
 */
function broadcastState(pipelineId, executionId, state, extras = {}) {
  try {
    const { broadcast } = require("../socketService");
    broadcast("pipeline:status", {
      id: pipelineId,
      pipeline_id: pipelineId,
      execution_id: executionId,
      status: state,
      state,
      ...extras,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {}
}

module.exports = {
  STATES,
  VALID_STATES,
  ABORT_FLAGS,
  PAUSE_FLAGS,
  ACTIVE_EXECUTIONS,
  RUNNERS,
  registerRunner,
  isValidState,
  uuid,
  safeJson,
  parseJson,
  broadcastState,
  logger,
};

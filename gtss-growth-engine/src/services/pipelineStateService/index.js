/**
 * index.js — re-exports the pipeline-state service module surface.
 *
 * This file preserves the exact same module.exports shape as the original
 * pipelineStateService.js monolith so that every caller (which uses
 * require("../services/pipelineStateService") or require("./pipelineStateService"))
 * continues to work without any changes.
 *
 * The split files in this directory share in-memory state (ABORT_FLAGS,
 * PAUSE_FLAGS, ACTIVE_EXECUTIONS, RUNNERS) via shared.js — those are Maps /
 * a plain object, so all files observe the SAME instance and mutations
 * propagate natively across files.
 *
 * Exports (matching the original):
 *   STATES, VALID_STATES, isValidState,
 *   createExecution, transitionExecution, updateExecutionProgress,
 *   markExecutionFailed, markExecutionCompleted,
 *   getActiveExecution, getExecutionState,
 *   isExecutionProgressing, hasStuckDbRow,
 *   requestPause, requestResume, requestStop, forceClearExecution,
 *   isPaused, isAborted, throwIfAborted, awaitResume,
 *   recoverOnStartup, canStart, registerRunner, RUNNERS,
 *   __setActive  (private hook used by retry / resume-from-checkpoint routes)
 */
"use strict";

const {
  STATES,
  VALID_STATES,
  ABORT_FLAGS,
  PAUSE_FLAGS,
  ACTIVE_EXECUTIONS,
  RUNNERS,
  registerRunner,
  isValidState,
} = require("./shared");

const {
  createExecution,
  transitionExecution,
  updateExecutionProgress,
  markExecutionFailed,
  markExecutionCompleted,
  getActiveExecution,
  getExecutionState,
  isExecutionProgressing,
  hasStuckDbRow,
} = require("./executions");

const {
  requestPause,
  requestResume,
  requestStop,
} = require("./pauseResumeStop");

const { forceClearExecution } = require("./forceClearExecution");

const {
  isPaused,
  isAborted,
  throwIfAborted,
  awaitResume,
} = require("./abortFlags");

const { recoverOnStartup, canStart } = require("./recovery");

module.exports = {
  STATES,
  VALID_STATES,
  isValidState,
  createExecution,
  transitionExecution,
  updateExecutionProgress,
  markExecutionFailed,
  markExecutionCompleted,
  getActiveExecution,
  getExecutionState,
  isExecutionProgressing,
  hasStuckDbRow,
  requestPause,
  requestResume,
  requestStop,
  forceClearExecution,
  isPaused,
  isAborted,
  throwIfAborted,
  awaitResume,
  recoverOnStartup,
  canStart,
  registerRunner,
  RUNNERS,
  // Private hook used by the retry-stage / resume-from-checkpoint routes to
  // re-arm the in-memory ACTIVE_EXECUTIONS map for an existing executionId
  // (without going through createExecution, which would refuse because the
  // pipelineId is no longer in the map after the previous run terminated).
  __setActive: (pipelineId, executionId) => {
    if (!pipelineId || !executionId) return;
    ACTIVE_EXECUTIONS.set(String(pipelineId), String(executionId));
    ABORT_FLAGS.delete(String(executionId));
    PAUSE_FLAGS.set(String(executionId), "running");
  },
};

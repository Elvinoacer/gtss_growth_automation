/**
 * Executor — emitState Helper
 *
 * emitState(emit, jobId, status, message, details) is the canonical way the
 * executor surfaces a state transition to the outside world:
 *   1. Persists the new status to the journal (updateJobStatus)
 *   2. Records a structured event for audit/replay (recordEvent)
 *   3. Emits the state over the emitter (Socket.IO + SSE)
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { updateJobStatus, recordEvent } = require('../journal');

function emitState(emit, jobId, status, message, details = {}) {
  updateJobStatus(jobId, status, details);
  recordEvent({
    jobId,
    status,
    platform: details.platform,
    actionType: details.actionType,
    target: details.target,
    messageId: details.messageId,
    leadId: details.leadId,
    warningDetected: details.warningDetected,
    details,
  });
  emit('state', message || status, { status, ...details });
}

module.exports = { emitState };

/**
 * Executor — SSE / Socket.IO Emitter Factory
 *
 * createEmitter(sseRes) returns an emit(type, message, data) function that
 * broadcasts every event to all Socket.IO clients and also writes to the
 * legacy SSE stream (if one was passed in).
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

const { broadcast } = require('../../services/socketService');

function createEmitter(sseRes) {
  return (type, message, data = {}) => {
    const payload = {
      type,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    };

    // Broadcast via Socket.IO to all connected clients
    broadcast('automation:log', payload);

    // Also broadcast queue/limits refresh signals on state changes
    if (['state', 'done', 'error', 'info'].includes(type)) {
      broadcast('automation:refresh', { type });
    }

    // Legacy SSE stream
    if (sseRes) {
      sseRes.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
}

module.exports = { createEmitter };

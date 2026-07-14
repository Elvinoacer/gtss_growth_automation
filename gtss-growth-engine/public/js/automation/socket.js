/* global gtss, io */
/**
 * automation/socket.js — Passive Socket.IO listener for the Automation
 * Control page.
 *
 * Pulled verbatim from the original automation.js IIFE (lines 952-959).
 * This is a GLOBAL listener (always active) that refreshes the queue +
 * limits whenever ANY automation:queue event arrives — e.g. from a run
 * started in another tab. The per-job listeners (automation:log,
 * automation:refresh, automation:queue for a specific job) are added
 * inside attachToAutomationJob (see execution.js) and removed when the
 * job finishes.
 */

// Global socket listeners — always active for passive real-time updates
const socket = getSocket();
if (socket) {
  socket.on('automation:queue', () => {
    loadQueue();
    loadLimits();
  });
}

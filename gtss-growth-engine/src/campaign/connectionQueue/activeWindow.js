/**
 * Connection Queue — Active-Window Compliance Helper
 *
 * Returns true if the current local hour is within the target platform's
 * configured operational window (policy.activeWindow). Platforms without an
 * activeWindow policy are treated as always-active.
 *
 * Mirrors the dmQueue/activeWindow.js pattern from Task 6.
 *
 * Extracted from the original connectionQueue.js for maintainability.
 */

/**
 * Checks if current hour is within target platform policy operational window.
 *
 * @param {object} policy - Target platform policy configuration
 * @returns {boolean} True if inside the active hours
 */
function isWithinActiveWindow(policy) {
  if (!policy || !policy.activeWindow) return true;
  const currentHour = new Date().getHours();
  return (
    currentHour >= policy.activeWindow.startHour &&
    currentHour < policy.activeWindow.endHour
  );
}

module.exports = {
  isWithinActiveWindow,
};

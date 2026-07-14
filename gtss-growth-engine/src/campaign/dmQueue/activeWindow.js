/**
 * DM Queue — Active-Window Compliance
 * Checks whether the current hour falls inside a platform policy's
 * activeWindow (e.g. "only send DMs between 9am and 6pm local time").
 *
 * Extracted from the original dmQueue.js for maintainability.
 */

/**
 * Checks if current hour is within target platform policy operational window.
 *
 * @param {object} policy - Target platform policy configuration
 * @returns {boolean} True if inside the active hours (or if policy has no
 *   activeWindow defined, in which case the platform is treated as always-on)
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

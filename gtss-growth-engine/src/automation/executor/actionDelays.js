/**
 * Executor — Action Delay Helpers
 *
 * parseDelayRange(value, fallback)
 *   Parse a "min,max" string into a { min, max } object (with a fallback).
 *
 * getActionDelayRange(platform, actionType)
 *   Resolve the inter-action cooldown range from env vars
 *   (e.g. LINKEDIN_DM_DELAY_MS) or fall back to 60s–180s.
 *
 * Extracted from the original automation/executor.js for maintainability.
 */

function parseDelayRange(value, fallback) {
  if (!value) return fallback;
  const parts = String(value)
    .split(',')
    .map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => Number.isNaN(part)))
    return fallback;
  return {
    min: Math.min(parts[0], parts[1]),
    max: Math.max(parts[0], parts[1]),
  };
}

function getActionDelayRange(platform, actionType) {
  const platformKey = `${platform}_${actionType}_DELAY_MS`.toUpperCase();
  return parseDelayRange(
    process.env[platformKey] || process.env.AUTOMATION_ACTION_DELAY_MS,
    { min: 60_000, max: 180_000 },
  );
}

module.exports = {
  parseDelayRange,
  getActionDelayRange,
};

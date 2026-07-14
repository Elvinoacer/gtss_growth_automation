/**
 * Browser Base — Locator Helpers & Selector Health
 * firstVisibleLocator, firstVisible (with selector-failure tracking),
 * igSelectorFailures, getSelectorHealthReport — resilient selector
 * fallback used across the Instagram helpers and the public firstVisible
 * export. Tracks per-selector miss counts so a health report can be
 * surfaced at run end via getSelectorHealthReport.
 * Extracted from the original browserBase.js for maintainability.
 */

// Per-selector miss counts (mutated by firstVisible). Kept module-local so
// getSelectorHealthReport can read the same object reference.
const igSelectorFailures = {};

async function firstVisibleLocator(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;

  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      try {
        await candidate.waitFor({
          state: "visible",
          timeout: Math.min(300, remaining),
        });
        return candidate;
      } catch (_) {
        // Try the next matching candidate.
      }
    }
  }

  return null;
}

/**
 * Resilient selector fallback helper.
 */
async function firstVisible(page, selectors, timeout = 1500) {
  const result = await firstVisibleLocator(page, selectors, timeout);
  if (!result) {
    const primary = Array.isArray(selectors) ? selectors[0] : selectors;
    if (primary) {
      igSelectorFailures[primary] = (igSelectorFailures[primary] || 0) + 1;
    }
  }
  return result;
}

function getSelectorHealthReport() {
  const warnings = [];
  for (const [selector, count] of Object.entries(igSelectorFailures)) {
    if (count > 3) {
      warnings.push(
        `[SELECTOR WARNING] Selector "${selector}" has failed ${count} times in this session.`,
      );
    }
  }
  return {
    failures: igSelectorFailures,
    warnings,
  };
}

module.exports = {
  igSelectorFailures,
  firstVisibleLocator,
  firstVisible,
  getSelectorHealthReport,
};

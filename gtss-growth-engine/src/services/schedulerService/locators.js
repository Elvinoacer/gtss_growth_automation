/**
 * Scheduler Service — Locator Helpers
 * firstVisibleLocator, isLocatorDisabled, firstEnabledLocator —
 * resilient Playwright selector helpers used across the per-platform
 * posting flows. `firstVisibleLocator` polls until any candidate
 * selector becomes visible and returns both the locator and the
 * selector that matched; `firstEnabledLocator` additionally skips
 * disabled / pointer-events:none / low-opacity elements so we never
 * click an inert button (e.g. Facebook's "Post" button while a media
 * upload is still processing).
 * Extracted from the original schedulerService.js for maintainability.
 */

async function firstVisibleLocator(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return { locator: candidate, selector };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function isLocatorDisabled(locator) {
  const ariaDisabled = await locator
    .getAttribute("aria-disabled")
    .catch(() => null);
  if (ariaDisabled === "true") return true;

  const disabled = await locator.getAttribute("disabled").catch(() => null);
  if (disabled !== null) return true;

  return locator
    .evaluate((el) => {
      const style = window.getComputedStyle(el);
      return (
        el.matches?.("[disabled], [aria-disabled='true']") ||
        style.pointerEvents === "none" ||
        Number.parseFloat(style.opacity || "1") < 0.35
      );
    })
    .catch(() => false);
}

async function firstEnabledLocator(scope, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) continue;
        if (await isLocatorDisabled(candidate)) continue;
        return { locator: candidate, selector };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

module.exports = {
  firstVisibleLocator,
  isLocatorDisabled,
  firstEnabledLocator,
};

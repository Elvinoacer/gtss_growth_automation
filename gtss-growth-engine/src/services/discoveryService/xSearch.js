/**
 * Discovery Service — X (Twitter) Search Capture & Extraction
 * Playwright helpers that locate, scroll, snapshot, and parse X user-search
 * result cards into normalised lead records.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { X_SEARCH_CARD_SELECTORS } = require("./constants");
const { delay, withTimeout } = require("./timing");
const { parseXSearchLeadSnapshot } = require("./textParsing");

/**
 * Wait for the first matching locator among `selectors` to become visible
 * within `timeout` ms. Returns the winning Playwright Locator, or null.
 */
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
 * In-page DOM scrape: capture up to `maxCards` X user-card snapshots (text +
 * hrefs) from the primary column container. Returns [] on any evaluate error.
 */
async function captureXSearchSnapshots(page, maxCards) {
  const selector = X_SEARCH_CARD_SELECTORS.join(", ");
  return page
    .evaluate(
      ({ selector: cardSelector, maxCards: limit }) => {
        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const container = document.querySelector('[data-testid="primaryColumn"]') || document;
        const cards = Array.from(container.querySelectorAll(cardSelector)).slice(0, Math.max(0, limit));

        return cards
          .map((card) => ({
            text: clean(card.innerText || ""),
            hrefs: Array.from(card.querySelectorAll("a[href]")).map((anchor) => anchor.getAttribute("href") || ""),
          }))
          .filter((snapshot) => snapshot.text || snapshot.hrefs.length);
      },
      { selector, maxCards },
    )
    .catch(() => []);
}

/**
 * Wait for the first X user-card to appear (15s timeout).
 */
async function waitForXSearchResults(page) {
  return firstVisibleLocator(page, X_SEARCH_CARD_SELECTORS, 15000);
}

/**
 * Scroll the X search page three times to trigger lazy-rendering of additional
 * user cards, then settle for 2s.
 */
async function scrollXSearchResults(page) {
  const viewport =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      .catch(() => ({ width: 1280, height: 800 })));
  const distance = Math.max(1200, Math.round(viewport.height * 1.25));

  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, distance).catch(() => {});
    await delay(800);
  }

  await delay(2000);
}

/**
 * Capture up to 120 X user-card snapshots (25s timeout), parse each into a
 * lead record, and dedupe by profile_url. Returns
 *   { selector, leads }
 * where `selector` is the human-readable DOM selector that was scraped.
 */
async function extractXSearchResults(page) {
  const snapshots = await withTimeout(captureXSearchSnapshots(page, 120), 25_000, "X search snapshot capture");

  const leads = [];
  const seen = new Set();

  for (const snapshot of snapshots) {
    const lead = parseXSearchLeadSnapshot(snapshot);
    if (!lead || !lead.profile_url) continue;

    const key = lead.profile_url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(lead);
  }

  return {
    selector: 'dom:[data-testid="UserCell"], dom:[data-testid="cellInnerDiv"]',
    leads,
  };
}

module.exports = {
  firstVisibleLocator,
  captureXSearchSnapshots,
  waitForXSearchResults,
  scrollXSearchResults,
  extractXSearchResults,
};

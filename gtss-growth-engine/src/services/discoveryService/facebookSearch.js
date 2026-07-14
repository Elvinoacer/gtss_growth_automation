/**
 * Discovery Service — Facebook Search Capture & Extraction
 * Playwright helpers that snapshot Facebook people-search anchors and parse
 * them into normalised lead records via parseFacebookSearchSnapshot.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { withTimeout } = require("./timing");
const { parseFacebookSearchSnapshot } = require("./textParsing");

/**
 * In-page DOM scrape: walk every Facebook people-search anchor, climb to its
 * closest card container (article / data-visualcompletion / div), and capture
 * the card's text + every href inside it. Returns [] on any evaluate error.
 */
async function captureFacebookSearchSnapshots(page, maxCards) {
  return page
    .evaluate((limit) => {
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const anchors = Array.from(
        document.querySelectorAll(
          'a[href*="facebook.com/"], a[href^="/"], a[href^="profile.php"]',
        ),
      );
      const snapshots = [];
      const seen = new Set();

      for (const anchor of anchors) {
        if (snapshots.length >= limit) break;

        const href = anchor.getAttribute("href") || "";
        if (!href || seen.has(href)) continue;

        const card =
          anchor.closest('[role="article"]') ||
          anchor.closest('[data-visualcompletion]') ||
          anchor.closest("div");
        const text = clean(card?.innerText || anchor.innerText || "");
        if (!text) continue;

        seen.add(href);
        snapshots.push({
          text,
          hrefs: [
            href,
            ...Array.from((card || anchor).querySelectorAll?.("a[href]") || []).map(
              (a) => a.getAttribute("href") || "",
            ),
          ],
        });
      }

      return snapshots;
    }, Math.max(0, maxCards))
    .catch(() => []);
}

/**
 * Capture up to 160 Facebook search card snapshots (25s timeout), parse each
 * into a lead record, and dedupe by profile_url. Returns
 *   { selector, leads }
 * where `selector` is the human-readable DOM selector that was scraped.
 */
async function extractFacebookSearchResults(page) {
  const snapshots = await withTimeout(
    captureFacebookSearchSnapshots(page, 160),
    25_000,
    "Facebook search snapshot capture",
  );
  const leads = [];
  const seen = new Set();

  for (const snapshot of snapshots) {
    const lead = parseFacebookSearchSnapshot(snapshot);
    if (!lead || !lead.profile_url) continue;
    const key = lead.profile_url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(lead);
  }

  return {
    selector: 'dom:a[href*="facebook.com/"], dom:a[href^="/"]',
    leads,
  };
}

module.exports = {
  captureFacebookSearchSnapshots,
  extractFacebookSearchResults,
};

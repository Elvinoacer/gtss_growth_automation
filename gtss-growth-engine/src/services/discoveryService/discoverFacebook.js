/**
 * Discovery Service — Facebook Per-Platform Discoverer
 * The Facebook branch of platformDiscoveryMap: opens a browser, navigates to
 * Facebook people-search, scrolls to load more cards, dedupes against the
 * in-run buffer and the DB, and returns the collected lead list.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { checkSessionExpired, captureFailureArtifact } = require("../../automation/browserBase");
const {
  delay,
  withTimeout,
  enforceVisitLimit,
  createBrowserContext,
  closeBrowserContext,
} = require("./timing");
const { isJobStopped } = require("./jobStreams");
const { extractFacebookSearchResults } = require("./facebookSearch");

/**
 * Facebook people-search discoverer.
 *
 * @param {string} kw - Search keywords
 * @param {number} max - Target new-lead count for this run
 * @param {function} emit - Event emitter (called with { type, platform, message })
 * @param {string|number} jobId - Used for isJobStopped() polling
 * @returns {Promise<object[]>} Collected lead records (including DB-duplicates)
 */
async function discoverLeadsOnFacebook(kw, max, emit, jobId) {
  const browserState = await createBrowserContext("facebook");
  const page = browserState.page;
  const db = getDb();
  const searchUrl = `https://www.facebook.com/search/people/?q=${encodeURIComponent(kw)}`;
  const rawLeads = [];
  const seen = new Set();
  let totalNewCount = 0;
  let stagnantRounds = 0;
  const MAX_STAGNANT = 4;
  const MAX_SCROLL_PASSES = 15;

  try {
    emit({ type: "info", platform: "facebook", message: "Opening Facebook People search..." });

    await enforceVisitLimit(emit);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await withTimeout(
          page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }),
          60000,
          "Facebook search navigation",
        );
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        emit({
          type: "warn",
          platform: "facebook",
          message: `Navigation attempt ${attempt} failed: ${err.message}. Retrying...`,
        });
        await delay(2000);
      }
    }

    emit({ type: "info", platform: "facebook", message: `Facebook search loaded: ${page.url()}` });
    await delay(3000);

    if (
      await checkSessionExpired(page, "facebook", (type, message) => emit({ type, platform: "facebook", message }))
    ) {
      emit({ type: "warn", platform: "facebook", message: "Facebook session expired before discovery started." });
      return [];
    }

    for (let pass = 1; pass <= MAX_SCROLL_PASSES; pass++) {
      if (isJobStopped(jobId)) break;
      if (totalNewCount >= max) break;

      emit({ type: "info", platform: "facebook", message: `Extracting Facebook results (pass ${pass})...` });

      const { selector, leads: cards } = await withTimeout(
        extractFacebookSearchResults(page),
        Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
        "Facebook search extraction",
      );

      let newOnPass = 0;
      for (const card of cards) {
        if (!card.profile_url) continue;
        const key = card.profile_url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(card.profile_url);
        if (!existsInDb) {
          totalNewCount += 1;
          newOnPass += 1;
        }

        rawLeads.push({
          ...card,
          source_keyword: kw,
        });

        if (totalNewCount >= max) break;
      }

      emit({
        type: "info",
        platform: "facebook",
        message: `Pass ${pass}: found ${cards.length} Facebook profiles using ${selector}, ${newOnPass} new. Total new: ${totalNewCount}/${max}.`,
      });

      if (totalNewCount >= max) break;

      if (newOnPass === 0) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }

      if (stagnantRounds >= MAX_STAGNANT) {
        emit({
          type: "info",
          platform: "facebook",
          message: "No new Facebook results after repeated scrolls; ending search.",
        });
        break;
      }

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
      await delay(2500);
      await enforceVisitLimit(emit);
    }

    return rawLeads;
  } catch (error) {
    await captureFailureArtifact(page, "facebook", "discovery-facebook");
    throw error;
  } finally {
    emit({ type: "info", platform: "facebook", message: "Closing Facebook discovery browser..." });
    await closeBrowserContext("facebook", browserState);
  }
}

module.exports = {
  discoverLeadsOnFacebook,
};

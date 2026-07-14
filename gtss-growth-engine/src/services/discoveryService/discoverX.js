/**
 * Discovery Service — X (Twitter) Per-Platform Discoverer
 * The X branch of platformDiscoveryMap: opens a browser, navigates to X
 * user-search, scrolls to load more cards, dedupes against the in-run buffer
 * and the DB, and returns the collected lead list.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { checkSessionExpired, captureFailureArtifact } = require("../../automation/browserBase");
const {
  delay,
  withTimeout,
  randomActionDelay,
  enforceVisitLimit,
  createBrowserContext,
  closeBrowserContext,
} = require("./timing");
const { isJobStopped } = require("./jobStreams");
const {
  waitForXSearchResults,
  extractXSearchResults,
  scrollXSearchResults,
} = require("./xSearch");

/**
 * X user-search discoverer.
 *
 * @param {string} kw - Search keywords
 * @param {number} max - Target new-lead count for this run
 * @param {function} emit - Event emitter (called with { type, platform, message })
 * @param {string|number} jobId - Used for isJobStopped() polling
 * @returns {Promise<object[]>} Collected lead records (including DB-duplicates)
 */
async function discoverLeadsOnX(kw, max, emit, jobId) {
  const browserState = await createBrowserContext("x");
  const page = browserState.page;
  const db = getDb();
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(kw)}&f=user`;
  const rawLeads = [];
  const seen = new Set();
  let totalNewCount = 0;
  let stagnantRounds = 0;
  let pass = 0;

  try {
    emit({
      type: "info",
      platform: "x",
      message: "Opening X people search...",
    });

    await enforceVisitLimit(emit);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await withTimeout(
          page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          }),
          60000,
          "X search navigation",
        );
        break;
      } catch (error) {
        if (attempt === 2) throw error;

        emit({
          type: "warn",
          platform: "x",
          message: `X search navigation attempt ${attempt} failed: ${error.message}. Retrying...`,
        });
        await delay(1500 * attempt);
      }
    }

    emit({
      type: "info",
      platform: "x",
      message: `X search page loaded: ${page.url()}`,
    });

    await delay(2500);

    if (await checkSessionExpired(page, "x", (type, message) => emit({ type, platform: "x", message }))) {
      emit({
        type: "warn",
        platform: "x",
        message: "X session is not authenticated or has expired before discovery started.",
      });
      await captureFailureArtifact(page, "x", "discovery-x-session-expired");
      return [];
    }

    await waitForXSearchResults(page).catch(() => {
      emit({
        type: "warn",
        platform: "x",
        message: "No visible X user result cards yet; continuing with scroll-based retries.",
      });
    });

    while (totalNewCount < max && !isJobStopped(jobId)) {
      pass += 1;

      emit({
        type: "info",
        platform: "x",
        message: `Extracting X search results (pass ${pass})...`,
      });

      const { selector, leads } = await withTimeout(
        extractXSearchResults(page),
        Number(process.env.DISCOVERY_PLATFORM_TIMEOUT_MS || 300_000),
        "X search extraction",
      );

      let newOnPass = 0;
      for (const lead of leads) {
        const dedupeKey = String(lead.profile_url || "").toLowerCase();
        if (!dedupeKey || seen.has(dedupeKey)) continue;

        seen.add(dedupeKey);
        const existsInDb = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(lead.profile_url);

        if (!existsInDb) {
          totalNewCount += 1;
          newOnPass += 1;
        }

        rawLeads.push({
          ...lead,
          source_keyword: kw,
        });

        if (totalNewCount >= max) break;
      }

      emit({
        type: "info",
        platform: "x",
        message: `Extracted ${leads.length} X profiles from pass ${pass} (${newOnPass} new) using ${selector}. Total new so far: ${totalNewCount}/${max}.`,
      });

      if (totalNewCount >= max) {
        emit({
          type: "info",
          platform: "x",
          message: `Target of ${max} new X leads reached.`,
        });
        break;
      }

      if (newOnPass === 0) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }

      if (stagnantRounds >= 5) {
        emit({
          type: "info",
          platform: "x",
          message: "No new X results after repeated scrolls; ending search.",
        });
        break;
      }

      emit({
        type: "info",
        platform: "x",
        message: "Scrolling X search results to load more users...",
      });

      await enforceVisitLimit(emit);
      await scrollXSearchResults(page);
      await page
        .locator('[data-testid="UserCell"]')
        .nth(0)
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      await randomActionDelay();

      if (await checkSessionExpired(page, "x", (type, message) => emit({ type, platform: "x", message }))) {
        emit({
          type: "warn",
          platform: "x",
          message: "X session expired during discovery; returning partial results collected so far.",
        });
        await captureFailureArtifact(page, "x", "discovery-x-session-expired");
        break;
      }
    }

    return rawLeads;
  } catch (error) {
    await captureFailureArtifact(page, "x", "discovery-x");
    throw error;
  } finally {
    await closeBrowserContext("x", browserState);
  }
}

module.exports = {
  discoverLeadsOnX,
};

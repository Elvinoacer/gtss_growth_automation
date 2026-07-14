/**
 * instagramDiscovery/discoveryFeedHelpers.js
 *
 * Low-level helpers for the feed-discovery scroll loop:
 *   - createDiscoveryMetrics()       Fresh per-run metrics counter object
 *   - createDiscoveryDetailPage()    Open a new tab in the existing context
 *   - closeDiscoveryDetailPage()     Close that detail tab safely
 *   - collectDiscoveryLinks()        Dedup list of /p/ post links on the page
 *   - readDiscoveryFeedState()       Read scrollHeight/scrollY/innerHeight
 *   - advanceDiscoveryFeed()         Scroll the feed up to N times looking for growth
 *
 * These were private helpers in the original instagramDiscovery.js and are
 * used by runInstagramFeedDiscovery.js. They are exported as __private in the
 * module's index.js so existing tests can introspect them.
 */

const { humanDelay } = require("../browserBase");
const {
  DISCOVERY_PAGINATION,
  safeEmit,
} = require("./shared");

function createDiscoveryMetrics() {
  return {
    iterations: 0,
    visibleLinks: 0,
    freshLinks: 0,
    processedLinks: 0,
    duplicateLinks: 0,
    duplicateUsernames: 0,
    dbDuplicates: 0,
    scrollAttempts: 0,
    stagnantRounds: 0,
    lastGrowthAt: Date.now(),
  };
}

async function createDiscoveryDetailPage(page) {
  const context = typeof page.context === "function" ? page.context() : null;
  if (!context || typeof context.newPage !== "function") {
    throw new Error(
      "Instagram discovery requires a browser context that supports newPage()",
    );
  }

  return context.newPage();
}

async function closeDiscoveryDetailPage(detailPage) {
  if (detailPage && typeof detailPage.close === "function") {
    await detailPage.close().catch(() => {});
  }
}

async function collectDiscoveryLinks(page) {
  const links = await page
    .$$eval('article a[href*="/p/"]', (els) => els.map((el) => el.href))
    .catch(() => []);
  const seen = new Set();
  return links.filter((link) => {
    const normalized = String(link || "").trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function readDiscoveryFeedState(page) {
  try {
    return await page.evaluate(() => ({
      scrollHeight: document.body ? document.body.scrollHeight : 0,
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
    }));
  } catch (_) {
    return { scrollHeight: 0, scrollY: 0, innerHeight: 0 };
  }
}

async function advanceDiscoveryFeed(
  page,
  emitter,
  label,
  currentCount,
  currentState,
) {
  let latestLinks = [];
  let latestState = currentState || {
    scrollHeight: 0,
    scrollY: 0,
    innerHeight: 0,
  };
  let grew = false;

  for (
    let attempt = 1;
    attempt <= DISCOVERY_PAGINATION.scrollAttemptsPerRound;
    attempt++
  ) {
    if (page.mouse && typeof page.mouse.wheel === "function") {
      await page.mouse.wheel(
        0,
        Math.max(600, Math.floor((latestState.innerHeight || 1200) * 0.9)),
      );
    } else {
      await page.evaluate(() =>
        window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600)),
      );
    }

    await humanDelay(1100, 1900);
    latestLinks = await collectDiscoveryLinks(page);
    latestState = await readDiscoveryFeedState(page);
    grew =
      latestLinks.length > currentCount ||
      latestState.scrollHeight > (currentState?.scrollHeight || 0);

    if (grew) {
      break;
    }
  }

  safeEmit(
    emitter,
    "info",
    `${label} pagination scroll result: links=${latestLinks.length}, scrollHeight=${latestState.scrollHeight}, grew=${grew}`,
  );

  return { grew, links: latestLinks, state: latestState };
}

module.exports = {
  createDiscoveryMetrics,
  createDiscoveryDetailPage,
  closeDiscoveryDetailPage,
  collectDiscoveryLinks,
  readDiscoveryFeedState,
  advanceDiscoveryFeed,
};

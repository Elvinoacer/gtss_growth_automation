const { getDb } = require("../db/database");
const browserBase = require("../automation/browserBase");
const logger = require("../utils/logger");

/**
 * Main function to crawl suggested accounts for a qualified Instagram lead and queue them.
 * @param {number} leadId - The database ID of the qualified lead.
 * @returns {Promise<{success: boolean, queuedCount?: number, error?: string}>}
 */
async function crawlAndQueueSuggestedAccounts(leadId) {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) {
    logger.error("IG_DISCOVERY", `Lead with ID ${leadId} not found.`);
    return { success: false, error: "lead_not_found" };
  }

  // Ensure lead username or profile URL is available
  let username = lead.ig_username;
  if (!username && lead.profile_url) {
    const match = lead.profile_url.match(/instagram\.com\/([a-zA-Z0-9_\.]+)/i);
    if (match) {
      username = match[1];
    }
  }

  if (!username) {
    logger.error("IG_DISCOVERY", `No Instagram username found for lead ID ${leadId}.`);
    return { success: false, error: "username_missing" };
  }

  logger.info("IG_DISCOVERY", `Starting suggested accounts crawl for @${username} (Lead ID: ${leadId})`);

  let browserState;
  try {
    browserState = await browserBase.createInstagramBrowser();
    const { page } = browserState;

    // Navigate to profile
    const profileUrl = `https://www.instagram.com/${username}/`;
    logger.info("IG_DISCOVERY", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    // Look for the "Similar accounts" toggle button
    const toggleSelectors = [
      'button:has(svg[aria-label*="Similar" i])',
      'div[role="button"]:has(svg[aria-label*="Similar" i])',
      'svg[aria-label*="Similar" i]',
      'button:has-text("Similar")',
      'span:has-text("Similar")'
    ];

    let toggleBtn = null;
    for (const selector of toggleSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible().catch(() => false)) {
        toggleBtn = el;
        break;
      }
    }

    if (toggleBtn) {
      logger.info("IG_DISCOVERY", "Clicking Similar accounts toggle button to show suggestions");
      await toggleBtn.click();
      await page.waitForTimeout(3000);
    } else {
      logger.info("IG_DISCOVERY", "Similar accounts toggle button not found or already open.");
    }

    // Now look for a "See all" link to expand recommendations
    const seeAllSelectors = [
      'a[href*="/suggested/"]',
      'span:has-text("See all")',
      'div:has-text("See all")',
      'button:has-text("See all")'
    ];

    let seeAllBtn = null;
    for (const selector of seeAllSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible().catch(() => false)) {
        seeAllBtn = el;
        break;
      }
    }

    if (seeAllBtn) {
      logger.info("IG_DISCOVERY", "Clicking See all button/link to expand suggestions list");
      await seeAllBtn.click();
      await page.waitForTimeout(5000);
    }

    // Extract suggested accounts
    const links = page.locator('a[href^="/"]');
    const count = await links.count().catch(() => 0);
    const suggestedUsernames = new Set();

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute("href").catch(() => "");
      const usernameMatch = href.match(/^\/([a-zA-Z0-9_\.]+)\/$/);
      if (usernameMatch) {
        const u = usernameMatch[1];
        const excluded = ["explore", "developer", "accounts", "legal", "about", "press", "directory", "direct", "emails", "p", "reels", "stories"];
        if (!excluded.includes(u) && u !== username) {
          suggestedUsernames.add(u);
        }
      }
      if (suggestedUsernames.size >= 10) break;
    }

    const pool = Array.from(suggestedUsernames).slice(0, 5);
    logger.info("IG_DISCOVERY", `Found suggested usernames pool: ${pool.join(", ")}`);

    let queuedCount = 0;
    for (const suggestedUser of pool) {
      // Check for duplicates
      const existsInLeads = db.prepare("SELECT id FROM leads WHERE ig_username = ? OR profile_url LIKE ?").get(suggestedUser, `%instagram.com/${suggestedUser}%`);
      const existsInQueue = db.prepare("SELECT id FROM ig_discovery_queue WHERE ig_username = ?").get(suggestedUser);

      if (!existsInLeads && !existsInQueue) {
        db.prepare(
          "INSERT INTO ig_discovery_queue (ig_username, source, processed) VALUES (?, ?, 0)"
        ).run(suggestedUser, `suggested_from_${username}`);
        queuedCount++;
        logger.info("IG_DISCOVERY", `Queued suggested user: @${suggestedUser}`);
      } else {
        logger.info("IG_DISCOVERY", `Skipping @${suggestedUser} (already exists in database)`);
      }
    }

    logger.info("IG_DISCOVERY", `Successfully queued ${queuedCount} suggested accounts for @${username}`);
    return { success: true, queuedCount };

  } catch (err) {
    logger.error("IG_DISCOVERY", `Error crawling suggested accounts for @${username}: ${err.message}`, err);
    return { success: false, error: err.message };
  } finally {
    if (browserState) {
      await browserBase.closeBrowser(browserState.browser, "instagram", browserState.context, {
        lock: browserState.lock,
        mode: browserState.mode,
        tracePath: browserState.tracePath
      });
    }
  }
}

module.exports = {
  crawlAndQueueSuggestedAccounts
};

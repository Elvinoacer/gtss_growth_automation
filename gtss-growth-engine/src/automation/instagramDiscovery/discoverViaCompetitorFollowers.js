/**
 * instagramDiscovery/discoverViaCompetitorFollowers.js
 *
 * Discover business leads by scraping the followers modal of a competitor
 * account. Different from discoverViaHashtag / discoverViaGeolocation because
 * the source is the followers list inside a dialog, not an explore feed — so
 * it does NOT use runInstagramFeedDiscovery. Instead it:
 *
 *   1. Navigate to instagram.com/<targetAccount>/
 *   2. Open the followers modal (a[href*="/followers/"] → div[role="dialog"])
 *   3. Scroll the dialog container 5 times to load more handles
 *   4. Collect every a[href^="/"][href$="/"] inside the dialog, filtering out
 *      generic system paths (about, help, press, terms, accounts, etc.)
 *   5. For each username (capped at maxProfiles):
 *        - Skip if already in the leads table
 *        - scrapeProfileForLead → filterBusinessProfile
 *        - If qualified: INSERT INTO leads with source = competitor_followers:<account>
 *        - igDelay('betweenProfileVisits') + goBack to followers list
 *        - If the modal got closed during navigation, re-open it
 *
 * Returns { success, count, leads } on success, { success:false, error } on
 * fatal error.
 */

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
} = require("../browserBase");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { safeEmit, igDelay } = require("./shared");
const { scrapeProfileForLead } = require("./scrapeProfileForLead");
const { filterBusinessProfile } = require("./filterBusinessProfile");

/**
 * Automate discover via Instagram Competitor Followers.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.targetAccount - Username of competitor account
 * @param {number} [params.maxProfiles=25] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaCompetitorFollowers(
  page,
  { targetAccount, maxProfiles = 25 },
  emitter,
) {
  try {
    safeEmit(emitter, "info", `Scraping followers of @${targetAccount}`);

    // 2. Navigate to instagram.com/{targetAccount}/
    const profileUrl = `https://www.instagram.com/${targetAccount}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 3. Click the followers count link to open followers modal using selector
    const followersLink = await firstVisible(
      page,
      [
        'a[href*="/followers/"]',
        'li:has-text("followers") a',
        'span:has-text("followers")',
      ],
      5000,
    );
    if (!followersLink) {
      safeEmit(emitter, "error", "Could not find followers count link");
      return { success: false, error: "followers_link_not_found" };
    }
    await followersLink.click();
    await humanDelay(2000, 4000);

    // 4. Wait for modal div[role="dialog"]
    await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });

    // 5. Scroll container inside the modal (scrollIntoView + scroll DOWN 300px, wait 2s, repeat up to 5 times)
    const scrollableLocator = page.locator(
      'div[role="dialog"] div[style*="overflow-y"], div[role="dialog"] ul, div[role="dialog"] ._is12',
    );
    const scrollableCount = await scrollableLocator.count().catch(() => 0);

    if (scrollableCount > 0) {
      const scrollableContainer = scrollableLocator.first();
      for (let i = 0; i < 5; i++) {
        await scrollableContainer.evaluate((el) => {
          el.scrollIntoView();
          el.scrollBy(0, 300);
        });
        await humanDelay(2000, 2000); // Pause exactly 2s
      }
    }

    // 6. Collect username links matching div[role="dialog"] a[href^="/"][href$="/"]
    // Exclude generic/noise system paths
    const links = page.locator('div[role="dialog"] a[href^="/"][href$="/"]');
    const count = await links.count().catch(() => 0);
    const usernames = [];
    const seenInModal = new Set();

    for (let i = 0; i < count; i++) {
      const href = await links
        .nth(i)
        .getAttribute("href")
        .catch(() => "");
      if (href) {
        const username = href
          .replace(/^\/|\/$/g, "")
          .trim()
          .split("?")[0];
        if (
          username &&
          username.toLowerCase() !== targetAccount.toLowerCase() &&
          !seenInModal.has(username.toLowerCase()) &&
          ![
            "about",
            "help",
            "press",
            "api",
            "jobs",
            "privacy",
            "terms",
            "explore",
            "direct",
            "emails",
            "accounts",
            "reels",
            "stories",
            "p",
            "tags",
          ].includes(username.toLowerCase())
        ) {
          usernames.push(username);
          seenInModal.add(username.toLowerCase());
        }
      }
    }

    safeEmit(
      emitter,
      "info",
      `Discovered ${usernames.length} followers in dialog list.`,
    );

    const db = getDb();
    let savedCount = 0;
    const savedLeads = [];
    const profilesToProcess = usernames.slice(0, maxProfiles);

    // 7. For each username (up to maxProfiles):
    for (const username of profilesToProcess) {
      try {
        // a. Navigate to profile is handled by scrapeProfileForLead internally, but let's log
        safeEmit(emitter, "info", `Processing follower: @${username}`);

        // Double check database deduplication first
        const dbCheck = db
          .prepare("SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?)")
          .get(username);
        if (dbCheck) {
          safeEmit(
            emitter,
            "skipped",
            `Skipping @${username} (already exists in the database)`,
          );
          continue;
        }

        // b. scrapeProfileForLead()
        const profileData = await scrapeProfileForLead(page, username, emitter);
        if (!profileData) {
          // If scraping failed, try to go back just in case
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await humanDelay(2000, 3000);
          continue;
        }

        // c. filterBusinessProfile()
        const filterResult = filterBusinessProfile(profileData);

        // d. If passes: insert to leads DB
        if (filterResult.passes) {
          db.prepare(
            `
            INSERT OR IGNORE INTO leads (
              platform, source_keyword, status, ig_username, name, company,
              ig_follower_count, ig_following_count, ig_post_count, ig_is_business,
              ig_business_category, ig_has_email, ig_has_phone, ig_bio, website,
              profile_url, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          ).run(
            "instagram",
            `competitor_followers:${targetAccount}`,
            "discovered",
            profileData.username,
            profileData.display_name,
            profileData.display_name,
            profileData.follower_count,
            profileData.following_count,
            profileData.post_count,
            profileData.is_business ? 1 : 0,
            profileData.business_category,
            profileData.email ? 1 : 0,
            profileData.phone ? 1 : 0,
            profileData.bio,
            profileData.website,
            profileData.profile_url,
            `Email: ${profileData.email || "N/A"} | Phone: ${profileData.phone || "N/A"}`,
          );

          savedLeads.push(profileData);
          savedCount++;
          safeEmit(
            emitter,
            "saved",
            `Saved qualified business lead: @${username} - Reason: ${filterResult.reason}`,
            profileData,
          );
        } else {
          safeEmit(
            emitter,
            "skipped",
            `Filtered out @${username} - Reason: ${filterResult.reason}`,
            profileData,
          );
        }

        // e. igDelay('betweenProfileVisits')
        await igDelay("betweenProfileVisits");

        // f. Return to follower list (back navigation)
        safeEmit(emitter, "info", "Navigating back to followers list...");
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 3000);

        // Resilient Modal State Check
        const modalVisible = await page
          .locator('div[role="dialog"]')
          .isVisible()
          .catch(() => false);
        if (!modalVisible) {
          safeEmit(
            emitter,
            "info",
            "Followers modal was closed after going back. Re-opening...",
          );
          await page
            .goto(profileUrl, { waitUntil: "domcontentloaded" })
            .catch(() => {});
          await humanDelay(2000, 3000);
          const fLink = await firstVisible(
            page,
            [
              'a[href*="/followers/"]',
              'li:has-text("followers") a',
              'span:has-text("followers")',
            ],
            5000,
          ).catch(() => null);
          if (fLink) {
            await fLink.click();
            await humanDelay(2000, 3000);
            await page
              .waitForSelector('div[role="dialog"]', { timeout: 10000 })
              .catch(() => {});
          }
        }
      } catch (err) {
        logger.error(
          "IG_DISCOVERY",
          `Error processing competitor follower @${username}: ${err.message}`,
        );
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 3000);
      }
    }

    safeEmit(
      emitter,
      "done",
      `Competitor follower discovery finished. Successfully saved ${savedCount} qualified leads from @${targetAccount}`,
    );
    return { success: true, count: savedCount, leads: savedLeads };
  } catch (err) {
    logger.error("Instagram discoverViaCompetitorFollowers Failed", {
      targetAccount,
      error: err.message,
    });
    safeEmit(
      emitter,
      "error",
      `Competitor follower discovery failed: ${err.message}`,
    );
    return { success: false, error: err.message };
  }
}

module.exports = { discoverViaCompetitorFollowers };

/**
 * instagramReplyChecker/followBacks.js — IG follower-list follow-back detector.
 *
 * Opens an authenticated IG browser, navigates to the signed-in user's
 * profile, scrolls the followers dialog to lazy-load entries, harvests the
 * list of follower usernames, then for each one updates ig_follow_tracker
 * (follow_back_at) and leads (ig_follow_back_at) when the follower is a
 * tracked account we previously outreach'd. Writes a telemetry_logs row
 * (success or failure) and tears down the browser in the finally block.
 *
 * Public export: checkFollowBacks.
 *
 * Extracted from the original instagramReplyChecker.js for maintainability.
 */

const { getDb } = require("../../db/database");
const {
  createInstagramBrowser,
  dailySessionWarmup,
  humanDelay,
} = require("../../automation/browserBase");
const logger = require("../../utils/logger");

/**
 * Identify and track accounts that followed back.
 *
 * @returns {Promise<Object>} Summary metrics.
 */
async function checkFollowBacks() {
  const db = getDb();
  logger.info(
    "INSTAGRAM_REPLY_CHECKER",
    "Initializing checkFollowBacks scan...",
  );
  const startTime = Date.now();
  let browserState = null;
  let success = false;
  let errMessage = null;
  let newFollowBacksCount = 0;
  let totalDiscoveredFollowers = 0;

  try {
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    // Natural session warmup
    await dailySessionWarmup(page);

    // Navigate to homepage
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);

    // Extract own profile username
    let myUsername = "";
    const profileLink = page
      .locator(
        'a[href*="/"][role="link"]:has(svg[aria-label="Profile"]), a[href*="/"]:has-text("Profile")',
      )
      .first();
    let href = await profileLink.getAttribute("href").catch(() => "");
    if (href) {
      myUsername = href.replace(/\//g, "").trim().split("?")[0];
    }

    if (!myUsername) {
      // Fallback: sidebar link checks
      const sidebarProfileImage = page.locator('a[href*="/"]:has(img)').first();
      let fallbackHref = await sidebarProfileImage
        .getAttribute("href")
        .catch(() => "");
      if (fallbackHref) {
        myUsername = fallbackHref.replace(/\//g, "").trim().split("?")[0];
      }
    }

    if (!myUsername) {
      // Manual click navigation checks
      const profileButton = page
        .locator(
          'svg[aria-label="Profile"], a[href*="/"][role="link"]:has-text("Profile")',
        )
        .first();
      if ((await profileButton.count()) > 0) {
        await profileButton.click();
        await humanDelay(4000, 7000);
        const match = page.url().match(/instagram\.com\/([a-zA-Z0-9_\.]+)\/?/);
        if (match) {
          myUsername = match[1];
        }
      }
    }

    if (!myUsername) {
      logger.error(
        "INSTAGRAM_REPLY_CHECKER",
        "Could not detect own Instagram username. Aborting checks.",
      );
      return { success: false, error: "my_username_not_found" };
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Detected active username @${myUsername}. Loading followers list...`,
    );

    // Navigate to profile followers tab directly
    await page.goto(`https://www.instagram.com/${myUsername}/followers/`, {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(4000, 7000);

    // Scroll list container
    const scrollableContainer = page
      .locator(
        'div[role="dialog"] div[style*="overflow-y"], div[role="dialog"] ul, div[role="dialog"] ._is12',
      )
      .first();
    if ((await scrollableContainer.count()) > 0) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        "Scrolling followers container to lazy load entries...",
      );
      for (let s = 0; s < 3; s++) {
        await scrollableContainer.evaluate((el) => el.scrollBy(0, 500));
        await humanDelay(1500, 3000);
      }
    }

    // Gather anchor links
    const followerLinks = page.locator('div[role="dialog"] a[href]');
    const count = await followerLinks.count().catch(() => 0);
    const followerUsernames = new Set();

    for (let i = 0; i < count; i++) {
      const linkHref = await followerLinks
        .nth(i)
        .getAttribute("href")
        .catch(() => "");
      if (linkHref) {
        const username = linkHref.replace(/\//g, "").trim().split("?")[0];
        if (
          username &&
          username !== myUsername &&
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
          ].includes(username)
        ) {
          followerUsernames.add(username);
        }
      }
    }

    totalDiscoveredFollowers = followerUsernames.size;
    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Discovered ${totalDiscoveredFollowers} loaded followers.`,
    );

    const usernamesArray = Array.from(followerUsernames);

    for (const username of usernamesArray) {
      // Update follow tracker
      const trackerRes = db
        .prepare(
          `
        UPDATE ig_follow_tracker
        SET follow_back_at = datetime('now')
        WHERE username = ? AND follow_back_at IS NULL
      `,
        )
        .run(username);

      // Update leads table ig_follow_back_at
      const leadsRes = db
        .prepare(
          `
        UPDATE leads
        SET ig_follow_back_at = datetime('now')
        WHERE ig_username = ? AND ig_follow_back_at IS NULL
      `,
        )
        .run(username);

      if (trackerRes.changes > 0 || leadsRes.changes > 0) {
        logger.info(
          "INSTAGRAM_REPLY_CHECKER",
          `Recorded follow-back state for lead @${username}`,
        );
        newFollowBacksCount++;
      }
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Follow-back checks successfully completed. Marked ${newFollowBacksCount} profiles.`,
    );
    success = true;
    return { success: true, newFollowBacksCount, totalDiscoveredFollowers };
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      "Fatal exception during checkFollowBacks scanning",
      err,
    );
    errMessage = err.message;
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    try {
      db.prepare(
        `
        INSERT INTO telemetry_logs (platform, action_type, status, duration_ms, processed_count, success_count, error_count, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        "instagram",
        "check_follow_backs",
        success ? "success" : "failed",
        durationMs,
        totalDiscoveredFollowers,
        newFollowBacksCount,
        success ? 0 : 1,
        JSON.stringify({
          newFollowBacksCount,
          totalDiscoveredFollowers,
          error: errMessage,
          browserMode: browserState ? browserState.mode : "unknown",
        }),
      );
    } catch (telemetryErr) {
      logger.error(
        "INSTAGRAM_REPLY_CHECKER",
        "Failed to write checkFollowBacks telemetry",
        telemetryErr,
      );
    }

    if (browserState) {
      const { closeBrowser } = require("../../automation/browserBase");
      await closeBrowser(
        browserState.browser,
        "instagram",
        browserState.context,
        {
          mode: browserState.mode,
          tracePath: browserState.tracePath,
          shouldCloseBrowser: browserState.shouldCloseBrowser,
          lock: browserState.lock,
        },
      );
    }
  }
}

module.exports = {
  checkFollowBacks,
};

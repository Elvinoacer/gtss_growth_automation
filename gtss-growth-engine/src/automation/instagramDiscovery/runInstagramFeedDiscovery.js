/**
 * instagramDiscovery/runInstagramFeedDiscovery.js
 *
 * The main feed-discovery state machine. Used by discoverViaHashtag and
 * discoverViaGeolocation (which just wrap it with different URLs and labels).
 *
 * Algorithm:
 *   1. Open a second "detail" tab in the same browser context.
 *   2. Navigate the main page to the explore URL (tag or location).
 *   3. Loop:
 *        - Collect visible /p/ post links + scroll state
 *        - For each fresh link, open it in the detail tab, find the author
 *          link, dedup against seenUsernames + the leads table, scrape the
 *          profile via scrapeProfileForLead, score via filterBusinessProfile,
 *          and (if qualified) INSERT INTO leads.
 *        - Advance the feed via advanceDiscoveryFeed (mouse.wheel + state check)
 *        - Stop when: maxLeads reached, maxIterations exceeded, stagnant for
 *          DISCOVERY_PAGINATION.maxStagnantRounds, or idle for maxIdleMs.
 *   4. Emit a "done" event with a metrics summary and close the detail tab.
 *
 * Returns { success, count, leads } on success, or { success:false, error } on
 * an Instagram block / fatal error.
 */

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
} = require("../browserBase");
const { getDb } = require("../../db/database");
const { safeEmit, igDelay, DISCOVERY_PAGINATION } = require("./shared");
const { scrapeProfileForLead } = require("./scrapeProfileForLead");
const { filterBusinessProfile } = require("./filterBusinessProfile");
const {
  createDiscoveryMetrics,
  createDiscoveryDetailPage,
  closeDiscoveryDetailPage,
  collectDiscoveryLinks,
  readDiscoveryFeedState,
  advanceDiscoveryFeed,
} = require("./discoveryFeedHelpers");

async function runInstagramFeedDiscovery(
  page,
  { exploreUrl, sourceType, sourceKeyword, maxLeads, emitter },
) {
  const detailPage = await createDiscoveryDetailPage(page);
  const db = getDb();
  const seenUsernames = new Set();
  const processedLinks = new Set();
  const metrics = createDiscoveryMetrics();
  const savedLeads = [];
  let savedCount = 0;
  let exhaustedFeed = false;
  let iteration = 0;

  try {
    safeEmit(
      emitter,
      "info",
      `Starting ${sourceType} discovery at ${exploreUrl}`,
    );
    await page.goto(exploreUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.waitForSelector('article a[href*="/p/"]', { timeout: 15000 });

    const maxIterations = Math.max(
      DISCOVERY_PAGINATION.minMaxIterations,
      maxLeads * DISCOVERY_PAGINATION.maxIterationsMultiplier,
    );

    while (savedCount < maxLeads && iteration < maxIterations) {
      iteration += 1;
      metrics.iterations = iteration;

      const currentState = await readDiscoveryFeedState(page);
      const visibleLinks = await collectDiscoveryLinks(page);
      const freshLinks = visibleLinks.filter(
        (link) => !processedLinks.has(link),
      );
      const duplicateLinks = visibleLinks.length - freshLinks.length;

      metrics.visibleLinks = visibleLinks.length;
      metrics.freshLinks = freshLinks.length;
      metrics.duplicateLinks += duplicateLinks;
      metrics.processedLinks = processedLinks.size;

      safeEmit(
        emitter,
        "info",
        `[${sourceType}] iteration ${iteration}: visible=${visibleLinks.length}, fresh=${freshLinks.length}, processed=${processedLinks.size}, saved=${savedCount}, duplicates=${metrics.duplicateLinks}`,
      );

      if (!visibleLinks.length) {
        metrics.stagnantRounds += 1;
        safeEmit(
          emitter,
          "warn",
          `[${sourceType}] No post links visible on iteration ${iteration}.`,
        );
      } else if (!freshLinks.length) {
        metrics.stagnantRounds += 1;
        safeEmit(
          emitter,
          "info",
          `[${sourceType}] No new post links on iteration ${iteration}; scrolling for more content.`,
        );
      } else {
        metrics.stagnantRounds = 0;
      }

      if (metrics.stagnantRounds >= DISCOVERY_PAGINATION.maxStagnantRounds) {
        exhaustedFeed = true;
        safeEmit(
          emitter,
          "warn",
          `[${sourceType}] Feed appears exhausted after ${metrics.stagnantRounds} stagnant rounds.`,
        );
        break;
      }

      if (Date.now() - metrics.lastGrowthAt > DISCOVERY_PAGINATION.maxIdleMs) {
        exhaustedFeed = true;
        safeEmit(
          emitter,
          "warn",
          `[${sourceType}] Discovery idle timeout reached; stopping pagination.`,
        );
        break;
      }

      for (const link of freshLinks) {
        if (savedCount >= maxLeads) break;
        processedLinks.add(link);

        safeEmit(emitter, "info", `[${sourceType}] Opening post ${link}`);
        await detailPage
          .goto(link, { waitUntil: "domcontentloaded" })
          .catch(() => {});
        await humanDelay(1800, 3200);

        const blockCheck = await checkForInstagramBlock(detailPage);
        if (blockCheck.blocked) {
          safeEmit(
            emitter,
            "error",
            `Instagram block detected: ${blockCheck.reason}`,
          );
          return { success: false, error: blockCheck.reason };
        }

        const userEl = await firstVisible(
          detailPage,
          [
            'header a[role="link"]',
            "header a",
            "article header a",
            'a[href*="/"]:near(time)',
          ],
          4000,
        ).catch(() => null);

        if (!userEl) {
          safeEmit(
            emitter,
            "info",
            `[${sourceType}] Post author link could not be detected for ${link}; skipping.`,
          );
          continue;
        }

        const href = await userEl.getAttribute("href").catch(() => "");
        const text = await userEl.innerText().catch(() => "");
        const match =
          href.match(/\/([a-zA-Z0-9_.]+)\/$/) ||
          href.match(/\/([a-zA-Z0-9_.]+)/);
        const username = (match ? match[1] : text).trim().replace(/@/g, "");

        if (!username) {
          safeEmit(
            emitter,
            "info",
            `[${sourceType}] Failed to parse post owner handle for ${link}; skipping.`,
          );
          continue;
        }

        const lowerUser = username.toLowerCase();
        if (seenUsernames.has(lowerUser)) {
          metrics.duplicateUsernames += 1;
          safeEmit(
            emitter,
            "skipped",
            `Skipping @${username} (already processed in this discovery session)`,
          );
          continue;
        }
        seenUsernames.add(lowerUser);

        const dbCheck = db
          .prepare("SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?)")
          .get(username);
        if (dbCheck) {
          metrics.dbDuplicates += 1;
          safeEmit(
            emitter,
            "skipped",
            `Skipping @${username} (already exists in the database)`,
          );
          continue;
        }

        await igDelay("betweenProfileVisits");

        const profileData = await scrapeProfileForLead(
          detailPage,
          username,
          emitter,
        );
        if (!profileData) {
          continue;
        }

        const filterResult = filterBusinessProfile(profileData);
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
            sourceKeyword,
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
          savedCount += 1;
          metrics.lastGrowthAt = Date.now();
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
      }

      if (savedCount >= maxLeads) {
        break;
      }

      const scrollResult = await advanceDiscoveryFeed(
        page,
        emitter,
        sourceType,
        visibleLinks.length,
        currentState,
      );

      metrics.scrollAttempts += 1;
      if (scrollResult.grew) {
        metrics.lastGrowthAt = Date.now();
        metrics.stagnantRounds = 0;
      } else {
        metrics.stagnantRounds += 1;
      }

      if (!scrollResult.grew && !freshLinks.length) {
        exhaustedFeed = true;
        safeEmit(
          emitter,
          "warn",
          `[${sourceType}] No new posts after scrolling; ending discovery.`,
        );
        break;
      }
    }

    const finishReason = exhaustedFeed
      ? "feed exhausted or stalled"
      : savedCount >= maxLeads
        ? "target reached"
        : iteration >= maxIterations
          ? "iteration limit reached"
          : "completed";

    safeEmit(
      emitter,
      "done",
      `${sourceType} discovery finished (${finishReason}). Saved ${savedCount} qualified leads. Metrics: ${JSON.stringify(
        {
          iterations: metrics.iterations,
          visibleLinks: metrics.visibleLinks,
          freshLinks: metrics.freshLinks,
          processedLinks: processedLinks.size,
          duplicateLinks: metrics.duplicateLinks,
          duplicateUsernames: metrics.duplicateUsernames,
          dbDuplicates: metrics.dbDuplicates,
          scrollAttempts: metrics.scrollAttempts,
        },
      )}`,
    );

    return { success: true, count: savedCount, leads: savedLeads };
  } finally {
    await closeDiscoveryDetailPage(detailPage);
  }
}

module.exports = { runInstagramFeedDiscovery };

/**
 * instagramDiscovery/scrapeProfileForLead.js
 *
 * Navigate to a profile page and scrape all business-relevant fields:
 *   display name, verified badge, post/follower/following counts, bio,
 *   website URL, business/contact flags, business category, email, phone,
 *   and the most recent post's publication datetime (by opening the first
 *   grid thumbnail).
 *
 * Returns a structured profile object (or null on block / scrape failure).
 * The result is consumed by filterBusinessProfile() and then persisted by
 * the discovery runners (feed / competitor-followers).
 *
 * Depends on browserBase selectors + helpers, the shared safeEmit/parseIgCount
 * helpers, and the system logger.
 */

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove,
} = require("../browserBase");
const logger = require("../../utils/logger");
const { safeEmit, parseIgCount } = require("./shared");

/**
 * Navigate to a profile page and scrape all business-relevant fields.
 * @param {object} page - Playwright page context
 * @param {string} username - Target handle
 * @param {function} emitter - Progress log callback
 * @returns {object|null} Profile lead data structure or null
 */
async function scrapeProfileForLead(page, username, emitter) {
  try {
    safeEmit(emitter, "info", `Scraping profile for @${username}`);
    const profileUrl = `https://www.instagram.com/${username}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "warn",
        `Instagram block detected on profile scrape: ${blockCheck.reason}`,
      );
      return null;
    }

    // 1. Display Name
    const nameEl = await firstVisible(
      page,
      ["header section h1", "header h1", "header h2 + span", "h1"],
      2500,
    ).catch(() => null);
    const display_name = nameEl ? await nameEl.innerText().catch(() => "") : "";

    // 2. Verified status
    const verifiedBadge = await firstVisible(
      page,
      [
        'span[title="Verified"]',
        'svg[aria-label="Verified"]',
        'span:has-text("Verified")',
      ],
      1500,
    ).catch(() => null);
    const is_verified = verifiedBadge !== null;

    // 3. Stats counters: Posts, Followers, Following
    let post_count = 0;
    let follower_count = 0;
    let following_count = 0;

    const statsElements = await page
      .locator(
        "header ul li, header li, header span:has-text('followers'), header span:has-text('following'), header span:has-text('posts')",
      )
      .all()
      .catch(() => []);
    for (const el of statsElements) {
      const text = await el.innerText().catch(() => "");
      const lowerText = text.toLowerCase();
      if (lowerText.includes("posts")) {
        post_count = parseIgCount(text);
      } else if (lowerText.includes("followers")) {
        follower_count = parseIgCount(text);
      } else if (lowerText.includes("following")) {
        following_count = parseIgCount(text);
      }
    }

    // Secondary selector fallbacks if standard loop fails
    if (post_count === 0) {
      const postsEl = await firstVisible(
        page,
        ['span:has-text("posts")', 'li:has-text("posts")'],
        1000,
      ).catch(() => null);
      if (postsEl) post_count = parseIgCount(await postsEl.innerText());
    }
    if (follower_count === 0) {
      const followersEl = await firstVisible(
        page,
        [
          'a[href*="/followers/"]',
          'li:has-text("followers")',
          'span:has-text("followers")',
        ],
        1000,
      ).catch(() => null);
      if (followersEl)
        follower_count = parseIgCount(await followersEl.innerText());
    }
    if (following_count === 0) {
      const followingEl = await firstVisible(
        page,
        [
          'a[href*="/following/"]',
          'li:has-text("following")',
          'span:has-text("following")',
        ],
        1000,
      ).catch(() => null);
      if (followingEl)
        following_count = parseIgCount(await followingEl.innerText());
    }

    // 4. Bio
    const bioEl = await firstVisible(
      page,
      [
        "header section > div > span",
        "main header section > div:last-child > span",
        "div.-v74b span",
        "header section span",
      ],
      2000,
    ).catch(() => null);
    const bio = bioEl ? await bioEl.innerText().catch(() => "") : "";

    // 5. Website
    const websiteEl = await firstVisible(
      page,
      [
        'header a[href*="l.instagram.com"]',
        'header a[target="_blank"]',
        'header a[href*="http"]',
      ],
      2000,
    ).catch(() => null);

    let website = null;
    if (websiteEl) {
      const href = await websiteEl.getAttribute("href").catch(() => "");
      if (href) {
        try {
          const urlObj = new URL(href, "https://www.instagram.com");
          const uParam = urlObj.searchParams.get("u");
          website = uParam ? decodeURIComponent(uParam) : href;
        } catch (_) {
          website = href;
        }
      } else {
        website = await websiteEl.innerText().catch(() => null);
      }
    }

    // 6. Contact button / Business status
    const contactBtn = await firstVisible(
      page,
      [
        'button:has-text("Contact")',
        'button:has-text("Email")',
        'button:has-text("Call")',
        'div[role="button"]:has-text("Contact")',
        'a[href^="mailto:"]',
        'a[href^="tel:"]',
      ],
      2000,
    ).catch(() => null);
    const is_business = contactBtn !== null;

    // 7. Business Category
    const categoryEl = await firstVisible(
      page,
      [
        'header section div[class*="category"]',
        "header section div:has(h1) + div span",
        'span[class*="category"]',
      ],
      1500,
    ).catch(() => null);
    const business_category = categoryEl
      ? await categoryEl.innerText().catch(() => null)
      : null;

    // 8. Email
    const emailEl = await firstVisible(
      page,
      ['a[href^="mailto:"]'],
      1500,
    ).catch(() => null);
    let email = null;
    if (emailEl) {
      const mailto = await emailEl.getAttribute("href").catch(() => "");
      email = mailto.replace(/^mailto:/i, "").trim();
    }
    if (!email && bio) {
      const emailMatch = bio.match(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
      );
      if (emailMatch) {
        email = emailMatch[0];
      }
    }

    // 9. Phone
    const phoneEl = await firstVisible(page, ['a[href^="tel:"]'], 1500).catch(
      () => null,
    );
    let phone = null;
    if (phoneEl) {
      const tel = await phoneEl.getAttribute("href").catch(() => "");
      phone = tel.replace(/^tel:/i, "").trim();
    }
    if (!phone && bio) {
      const phoneMatch = bio.match(
        /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
      );
      if (phoneMatch) {
        phone = phoneMatch[0];
      }
    }

    // 10. Last Post Date (Click first grid element and extract time label)
    let last_post_date = null;
    try {
      const firstPost = await firstVisible(
        page,
        [
          'article a[href*="/p/"]',
          'div._aabd a[href*="/p/"]',
          'a[href*="/p/"]',
        ],
        3000,
      ).catch(() => null);

      if (firstPost) {
        safeEmit(
          emitter,
          "info",
          "Opening first grid post to extract publication time...",
        );
        await humanMouseMove(page, firstPost);
        await humanDelay(300, 600);
        await firstPost.click();
        await humanDelay(1500, 2500);

        const timeEl = await firstVisible(
          page,
          ["time[datetime]", "time"],
          4000,
        ).catch(() => null);

        if (timeEl) {
          last_post_date = await timeEl
            .getAttribute("datetime")
            .catch(() => null);
          if (!last_post_date) {
            last_post_date = await timeEl.innerText().catch(() => null);
          }
        }

        // Close post detail overlay
        const closeBtn = await firstVisible(
          page,
          [
            'svg[aria-label="Close"]',
            'button[aria-label="Close"]',
            'div[role="button"]:has(svg[aria-label="Close"])',
          ],
          2000,
        ).catch(() => null);

        if (closeBtn) {
          await closeBtn.click();
          await humanDelay(1000, 2000);
        }
      }
    } catch (postErr) {
      logger.warn(
        "IG_DISCOVERY",
        `Failed to get last post date for ${username}: ${postErr.message}`,
      );
    }

    const scrapedData = {
      display_name: display_name || username,
      username,
      bio,
      website,
      follower_count,
      following_count,
      post_count,
      is_business,
      business_category,
      email,
      phone,
      is_verified,
      profile_url: profileUrl,
      last_post_date,
    };

    safeEmit(emitter, "found", `Scraped data for @${username}`, scrapedData);
    return scrapedData;
  } catch (err) {
    logger.error("Instagram scrapeProfileForLead Failed", {
      username,
      error: err.message,
    });
    safeEmit(
      emitter,
      "error",
      `Scrape action failed for @${username}: ${err.message}`,
    );
    return null;
  }
}

module.exports = { scrapeProfileForLead };

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove
} = require("./browserBase");
const { getDb } = require("../db/database");
const logger = require("../utils/logger");

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const IG_DELAYS = {
  betweenProfileVisits: { min: 12000, max: 25000 },
  betweenFollows: { min: 45000, max: 120000 },
  betweenLikes: { min: 20000, max: 60000 },
  betweenDMs: { min: 60000, max: 180000 },
  afterHashtagLoad: { min: 5000, max: 12000 },
  afterAction: { min: 3000, max: 8000 }
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Perform a natural human-like pause matching Nairobi delay patterns.
 */
async function igDelay(type) {
  const range = IG_DELAYS[type] || { min: 3000, max: 8000 };
  await humanDelay(range.min, range.max);
}

/**
 * Emit log events to active emitter callbacks or system logger.
 */
function safeEmit(emitter, type, message, data = {}) {
  if (typeof emitter === "function") {
    try {
      emitter(type, message, data);
    } catch (_) {}
  } else if (emitter && typeof emitter.emit === "function") {
    try {
      emitter.emit(type, message, data);
    } catch (_) {}
  }
  const logLevel = type === "error" ? "error" : type === "warn" ? "warn" : "info";
  logger[logLevel]("INSTAGRAM_DISCOVERY", message, data);
}

/**
 * Parses Instagram-style metric suffix tags ("2.3K" -> 2300, "1.2M" -> 1200000).
 * @param {string|number} val - Suffix counts
 * @returns {number} Integer value representation
 */
function parseIgCount(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return val;
  
  let str = val.toString().trim().toUpperCase().replace(/,/g, "");
  let multiplier = 1;

  if (str.endsWith("K")) {
    multiplier = 1000;
    str = str.slice(0, -1);
  } else if (str.endsWith("M")) {
    multiplier = 1000000;
    str = str.slice(0, -1);
  }

  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num * multiplier);
}

/**
 * Analyzes a scraped Instagram profile against local business indicators (2 out of 6 must match).
 * @param {object} profileData - Raw scraped profile attributes
 * @returns {object} { passes: boolean, reason: string }
 */
function filterBusinessProfile(profileData) {
  if (!profileData) {
    return { passes: false, reason: "No profile data provided" };
  }

  let score = 0;
  const matches = [];

  // 1. Has website in bio
  if (profileData.website) {
    score++;
    matches.push("website_in_bio");
  }

  // 2. Has email or phone
  if (profileData.email || profileData.phone) {
    score++;
    matches.push("contact_info_present");
  }

  // 3. Follower count in range [100, 50000]
  const followers = profileData.follower_count || 0;
  if (followers >= 100 && followers <= 50000) {
    score++;
    matches.push(`follower_count_in_range_${followers}`);
  }

  // 4. Bio contains local business keywords
  const bioKeywords = [
    "owner", "founder", "ceo", "manager", "restaurant", "café",
    "cafe", "hotel", "shop", "salon", "gym", "bar", "grill",
    "nairobi", "kenya", "business"
  ];
  const bioText = (profileData.bio || "").toLowerCase();
  const keywordMatch = bioKeywords.some(keyword => bioText.includes(keyword));
  if (keywordMatch) {
    score++;
    matches.push("bio_keywords_matched");
  }

  // 5. Post count > 10
  const posts = profileData.post_count || 0;
  if (posts > 10) {
    score++;
    matches.push(`active_posts_${posts}`);
  }

  // 6. Business category is non-null
  if (profileData.business_category) {
    score++;
    matches.push(`business_category_${profileData.business_category}`);
  }

  const passes = score >= 2;
  return {
    passes,
    reason: passes
      ? `Qualified: Match score ${score} indicators: (${matches.join(", ")})`
      : `Disqualified: Match score ${score} indicators: (${matches.join(", ")})`
  };
}

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
      safeEmit(emitter, "warn", `Instagram block detected on profile scrape: ${blockCheck.reason}`);
      return null;
    }

    // 1. Display Name
    const nameEl = await firstVisible(page, [
      'header section h1',
      'header h1',
      'header h2 + span',
      'h1'
    ], 2500).catch(() => null);
    const display_name = nameEl ? await nameEl.innerText().catch(() => "") : "";

    // 2. Verified status
    const verifiedBadge = await firstVisible(page, [
      'span[title="Verified"]',
      'svg[aria-label="Verified"]',
      'span:has-text("Verified")'
    ], 1500).catch(() => null);
    const is_verified = verifiedBadge !== null;

    // 3. Stats counters: Posts, Followers, Following
    let post_count = 0;
    let follower_count = 0;
    let following_count = 0;

    const statsElements = await page.locator("header ul li, header li, header span:has-text('followers'), header span:has-text('following'), header span:has-text('posts')").all().catch(() => []);
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
      const postsEl = await firstVisible(page, ['span:has-text("posts")', 'li:has-text("posts")'], 1000).catch(() => null);
      if (postsEl) post_count = parseIgCount(await postsEl.innerText());
    }
    if (follower_count === 0) {
      const followersEl = await firstVisible(page, ['a[href*="/followers/"]', 'li:has-text("followers")', 'span:has-text("followers")'], 1000).catch(() => null);
      if (followersEl) follower_count = parseIgCount(await followersEl.innerText());
    }
    if (following_count === 0) {
      const followingEl = await firstVisible(page, ['a[href*="/following/"]', 'li:has-text("following")', 'span:has-text("following")'], 1000).catch(() => null);
      if (followingEl) following_count = parseIgCount(await followingEl.innerText());
    }

    // 4. Bio
    const bioEl = await firstVisible(page, [
      'header section > div > span',
      'main header section > div:last-child > span',
      'div.-v74b span',
      'header section span'
    ], 2000).catch(() => null);
    const bio = bioEl ? await bioEl.innerText().catch(() => "") : "";

    // 5. Website
    const websiteEl = await firstVisible(page, [
      'header a[href*="l.instagram.com"]',
      'header a[target="_blank"]',
      'header a[href*="http"]'
    ], 2000).catch(() => null);
    
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
    const contactBtn = await firstVisible(page, [
      'button:has-text("Contact")',
      'button:has-text("Email")',
      'button:has-text("Call")',
      'div[role="button"]:has-text("Contact")',
      'a[href^="mailto:"]',
      'a[href^="tel:"]'
    ], 2000).catch(() => null);
    const is_business = contactBtn !== null;

    // 7. Business Category
    const categoryEl = await firstVisible(page, [
      'header section div[class*="category"]',
      'header section div:has(h1) + div span',
      'span[class*="category"]'
    ], 1500).catch(() => null);
    const business_category = categoryEl ? await categoryEl.innerText().catch(() => null) : null;

    // 8. Email
    const emailEl = await firstVisible(page, ['a[href^="mailto:"]'], 1500).catch(() => null);
    let email = null;
    if (emailEl) {
      const mailto = await emailEl.getAttribute("href").catch(() => "");
      email = mailto.replace(/^mailto:/i, "").trim();
    }
    if (!email && bio) {
      const emailMatch = bio.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        email = emailMatch[0];
      }
    }

    // 9. Phone
    const phoneEl = await firstVisible(page, ['a[href^="tel:"]'], 1500).catch(() => null);
    let phone = null;
    if (phoneEl) {
      const tel = await phoneEl.getAttribute("href").catch(() => "");
      phone = tel.replace(/^tel:/i, "").trim();
    }
    if (!phone && bio) {
      const phoneMatch = bio.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      if (phoneMatch) {
        phone = phoneMatch[0];
      }
    }

    // 10. Last Post Date (Click first grid element and extract time label)
    let last_post_date = null;
    try {
      const firstPost = await firstVisible(page, [
        'article a[href*="/p/"]',
        'div._aabd a[href*="/p/"]',
        'a[href*="/p/"]'
      ], 3000).catch(() => null);

      if (firstPost) {
        safeEmit(emitter, "info", "Opening first grid post to extract publication time...");
        await humanMouseMove(page, firstPost);
        await humanDelay(300, 600);
        await firstPost.click();
        await humanDelay(1500, 2500);

        const timeEl = await firstVisible(page, [
          'time[datetime]',
          'time'
        ], 4000).catch(() => null);

        if (timeEl) {
          last_post_date = await timeEl.getAttribute("datetime").catch(() => null);
          if (!last_post_date) {
            last_post_date = await timeEl.innerText().catch(() => null);
          }
        }

        // Close post detail overlay
        const closeBtn = await firstVisible(page, [
          'svg[aria-label="Close"]',
          'button[aria-label="Close"]',
          'div[role="button"]:has(svg[aria-label="Close"])'
        ], 2000).catch(() => null);
        
        if (closeBtn) {
          await closeBtn.click();
          await humanDelay(1000, 2000);
        }
      }
    } catch (postErr) {
      logger.warn("IG_DISCOVERY", `Failed to get last post date for ${username}: ${postErr.message}`);
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
      last_post_date
    };

    safeEmit(emitter, "found", `Scraped data for @${username}`, scrapedData);
    return scrapedData;
  } catch (err) {
    logger.error("Instagram scrapeProfileForLead Failed", { username, error: err.message });
    safeEmit(emitter, "error", `Scrape action failed for @${username}: ${err.message}`);
    return null;
  }
}

/**
 * Automate discover via Instagram hashtags.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.hashtag - Hashtag text to explore
 * @param {number} [params.maxLeads=30] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaHashtag(page, { hashtag, maxLeads = 30 }, emitter) {
  try {
    safeEmit(emitter, "info", `Starting hashtag discovery: #${hashtag}`);
    const exploreUrl = `https://www.instagram.com/explore/tags/${hashtag}/`;
    await page.goto(exploreUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // Wait for the grid of posts to appear
    await page.waitForSelector('article a[href*="/p/"]', { timeout: 15000 });

    const seenUsernames = new Set();
    const db = getDb();
    let savedCount = 0;
    const savedLeads = [];
    let iteration = 0;

    while (savedCount < maxLeads && iteration < 10) {
      iteration++;

      // Collect all visible posts in grid
      const postLinks = await page.$$eval('article a[href*="/p/"]', els => els.map(e => e.href)).catch(() => []);
      if (postLinks.length === 0) {
        safeEmit(emitter, "info", "No links found in the hashtag search grid.");
        break;
      }

      safeEmit(emitter, "info", `Found ${postLinks.length} post links in explore grid (Iteration ${iteration})`);

      for (const link of postLinks) {
        if (savedCount >= maxLeads) break;

        safeEmit(emitter, "info", `Navigating to grid post: ${link}`);
        await page.goto(link, { waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 4000);

        // Check for blocks
        const blockCheck = await checkForInstagramBlock(page);
        if (blockCheck.blocked) {
          safeEmit(emitter, "error", `Instagram block detected: ${blockCheck.reason}`);
          return { success: false, error: blockCheck.reason };
        }

        // Identify poster handle from post header
        const userEl = await firstVisible(page, [
          'header a[role="link"]',
          'header a',
          'article header a',
          'a[href*="/"]:near(time)'
        ], 4000).catch(() => null);

        if (!userEl) {
          safeEmit(emitter, "info", "Post author link could not be detected, skipping.");
          continue;
        }

        const href = await userEl.getAttribute("href").catch(() => "");
        const text = await userEl.innerText().catch(() => "");
        const match = href.match(/\/([a-zA-Z0-9_.]+)\/$/) || href.match(/\/([a-zA-Z0-9_.]+)/);
        const username = (match ? match[1] : text).trim().replace(/@/g, "");

        if (!username) {
          safeEmit(emitter, "info", "Failed to parse post owner handle, skipping.");
          continue;
        }

        const lowerUser = username.toLowerCase();

        // 1. Session Deduplication
        if (seenUsernames.has(lowerUser)) {
          safeEmit(emitter, "skipped", `Skipping @${username} (already processed in this discovery session)`);
          continue;
        }
        seenUsernames.add(lowerUser);

        // 2. Database Deduplication
        const dbCheck = db.prepare("SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?)").get(username);
        if (dbCheck) {
          safeEmit(emitter, "skipped", `Skipping @${username} (already exists in the database)`);
          continue;
        }

        // Nairobi human delay between profile visits
        await igDelay("betweenProfileVisits");

        // 3. Scrape Profile details
        const profileData = await scrapeProfileForLead(page, username, emitter);
        if (!profileData) {
          continue;
        }

        // 4. Business qualifications filter
        const filterResult = filterBusinessProfile(profileData);
        if (filterResult.passes) {
          // 5. Insert new qualified lead record using INSERT OR IGNORE
          db.prepare(`
            INSERT OR IGNORE INTO leads (
              platform, source_keyword, status, ig_username, name, company,
              ig_follower_count, ig_following_count, ig_post_count, ig_is_business,
              ig_business_category, ig_has_email, ig_has_phone, ig_bio, website,
              profile_url, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            "instagram",
            `hashtag:${hashtag}`,
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
            `Email: ${profileData.email || "N/A"} | Phone: ${profileData.phone || "N/A"}`
          );

          savedLeads.push(profileData);
          savedCount++;
          safeEmit(emitter, "saved", `Saved qualified business lead: @${username} - Reason: ${filterResult.reason}`, profileData);
        } else {
          safeEmit(emitter, "skipped", `Filtered out @${username} - Reason: ${filterResult.reason}`, profileData);
        }
      }

      if (savedCount >= maxLeads) break;

      // Scroll to trigger next batch load if we require more leads
      safeEmit(emitter, "info", "Navigating back to hashtag explore tag grid to scroll and load more posts...");
      await page.goto(exploreUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await humanDelay(2000, 3000);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await humanDelay(3000, 5000);
    }

    safeEmit(emitter, "done", `Hashtag discovery finished. Successfully saved ${savedCount} qualified leads for #${hashtag}`);
    return { success: true, count: savedCount, leads: savedLeads };
  } catch (err) {
    logger.error("Instagram discoverViaHashtag Failed", { hashtag, error: err.message });
    safeEmit(emitter, "error", `Hashtag discovery failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Automate discover via Instagram Geolocation tags.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.locationId - Instagram Location ID
 * @param {string} params.locationName - Geolocation title string
 * @param {number} [params.maxLeads=30] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaGeolocation(page, { locationId, locationName, maxLeads = 30 }, emitter) {
  try {
    safeEmit(emitter, "info", `Starting location discovery: ${locationName} (${locationId})`);
    const exploreUrl = `https://www.instagram.com/explore/locations/${locationId}/`;
    await page.goto(exploreUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // Wait for the grid of posts to appear
    await page.waitForSelector('article a[href*="/p/"]', { timeout: 15000 });

    const seenUsernames = new Set();
    const db = getDb();
    let savedCount = 0;
    const savedLeads = [];
    let iteration = 0;

    while (savedCount < maxLeads && iteration < 10) {
      iteration++;

      // Collect all visible posts in grid
      const postLinks = await page.$$eval('article a[href*="/p/"]', els => els.map(e => e.href)).catch(() => []);
      if (postLinks.length === 0) {
        safeEmit(emitter, "info", "No links found in the location explore grid.");
        break;
      }

      safeEmit(emitter, "info", `Found ${postLinks.length} post links in geolocation grid (Iteration ${iteration})`);

      for (const link of postLinks) {
        if (savedCount >= maxLeads) break;

        safeEmit(emitter, "info", `Navigating to grid post: ${link}`);
        await page.goto(link, { waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 4000);

        // Check for blocks
        const blockCheck = await checkForInstagramBlock(page);
        if (blockCheck.blocked) {
          safeEmit(emitter, "error", `Instagram block detected: ${blockCheck.reason}`);
          return { success: false, error: blockCheck.reason };
        }

        // Identify poster handle from post header
        const userEl = await firstVisible(page, [
          'header a[role="link"]',
          'header a',
          'article header a',
          'a[href*="/"]:near(time)'
        ], 4000).catch(() => null);

        if (!userEl) {
          safeEmit(emitter, "info", "Post author link could not be detected, skipping.");
          continue;
        }

        const href = await userEl.getAttribute("href").catch(() => "");
        const text = await userEl.innerText().catch(() => "");
        const match = href.match(/\/([a-zA-Z0-9_.]+)\/$/) || href.match(/\/([a-zA-Z0-9_.]+)/);
        const username = (match ? match[1] : text).trim().replace(/@/g, "");

        if (!username) {
          safeEmit(emitter, "info", "Failed to parse post owner handle, skipping.");
          continue;
        }

        const lowerUser = username.toLowerCase();

        // 1. Session Deduplication
        if (seenUsernames.has(lowerUser)) {
          safeEmit(emitter, "skipped", `Skipping @${username} (already processed in this location session)`);
          continue;
        }
        seenUsernames.add(lowerUser);

        // 2. Database Deduplication
        const dbCheck = db.prepare("SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?)").get(username);
        if (dbCheck) {
          safeEmit(emitter, "skipped", `Skipping @${username} (already exists in the database)`);
          continue;
        }

        // Nairobi human delay between profile visits
        await igDelay("betweenProfileVisits");

        // 3. Scrape Profile details
        const profileData = await scrapeProfileForLead(page, username, emitter);
        if (!profileData) {
          continue;
        }

        // 4. Business qualifications filter
        const filterResult = filterBusinessProfile(profileData);
        if (filterResult.passes) {
          // 5. Insert new qualified lead record using INSERT OR IGNORE
          db.prepare(`
            INSERT OR IGNORE INTO leads (
              platform, source_keyword, status, ig_username, name, company,
              ig_follower_count, ig_following_count, ig_post_count, ig_is_business,
              ig_business_category, ig_has_email, ig_has_phone, ig_bio, website,
              profile_url, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
            "instagram",
            `geolocation:${locationId}:${locationName}`,
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
            `Email: ${profileData.email || "N/A"} | Phone: ${profileData.phone || "N/A"}`
          );

          savedLeads.push(profileData);
          savedCount++;
          safeEmit(emitter, "saved", `Saved qualified business lead: @${username} - Reason: ${filterResult.reason}`, profileData);
        } else {
          safeEmit(emitter, "skipped", `Filtered out @${username} - Reason: ${filterResult.reason}`, profileData);
        }
      }

      if (savedCount >= maxLeads) break;

      // Scroll to trigger next batch load if we require more leads
      safeEmit(emitter, "info", "Navigating back to location tag explore grid to scroll and load more posts...");
      await page.goto(exploreUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await humanDelay(2000, 3000);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await humanDelay(3000, 5000);
    }

    safeEmit(emitter, "done", `Location discovery finished. Successfully saved ${savedCount} qualified leads for ${locationName}`);
    return { success: true, count: savedCount, leads: savedLeads };
  } catch (err) {
    logger.error("Instagram discoverViaGeolocation Failed", { locationId, locationName, error: err.message });
    safeEmit(emitter, "error", `Location discovery failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Automate discover via Instagram Competitor Followers.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.targetAccount - Username of competitor account
 * @param {number} [params.maxProfiles=25] - Total lead target count
 * @param {function} emitter - Progress log callback
 */
async function discoverViaCompetitorFollowers(page, { targetAccount, maxProfiles = 25 }, emitter) {
  try {
    safeEmit(emitter, "info", `Scraping followers of @${targetAccount}`);

    // 2. Navigate to instagram.com/{targetAccount}/
    const profileUrl = `https://www.instagram.com/${targetAccount}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(emitter, "error", `Instagram block detected: ${blockCheck.reason}`);
      return { success: false, error: blockCheck.reason };
    }

    // 3. Click the followers count link to open followers modal using selector
    const followersLink = await firstVisible(page, [
      'a[href*="/followers/"]',
      'li:has-text("followers") a',
      'span:has-text("followers")'
    ], 5000);
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
      'div[role="dialog"] div[style*="overflow-y"], div[role="dialog"] ul, div[role="dialog"] ._is12'
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
      const href = await links.nth(i).getAttribute("href").catch(() => "");
      if (href) {
        const username = href.replace(/^\/|\/$/g, "").trim().split("?")[0];
        if (
          username &&
          username.toLowerCase() !== targetAccount.toLowerCase() &&
          !seenInModal.has(username.toLowerCase()) &&
          ![
            "about", "help", "press", "api", "jobs", "privacy",
            "terms", "explore", "direct", "emails", "accounts",
            "reels", "stories", "p", "tags"
          ].includes(username.toLowerCase())
        ) {
          usernames.push(username);
          seenInModal.add(username.toLowerCase());
        }
      }
    }

    safeEmit(emitter, "info", `Discovered ${usernames.length} followers in dialog list.`);

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
        const dbCheck = db.prepare("SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?)").get(username);
        if (dbCheck) {
          safeEmit(emitter, "skipped", `Skipping @${username} (already exists in the database)`);
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
          db.prepare(`
            INSERT OR IGNORE INTO leads (
              platform, source_keyword, status, ig_username, name, company,
              ig_follower_count, ig_following_count, ig_post_count, ig_is_business,
              ig_business_category, ig_has_email, ig_has_phone, ig_bio, website,
              profile_url, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
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
            `Email: ${profileData.email || "N/A"} | Phone: ${profileData.phone || "N/A"}`
          );

          savedLeads.push(profileData);
          savedCount++;
          safeEmit(emitter, "saved", `Saved qualified business lead: @${username} - Reason: ${filterResult.reason}`, profileData);
        } else {
          safeEmit(emitter, "skipped", `Filtered out @${username} - Reason: ${filterResult.reason}`, profileData);
        }

        // e. igDelay('betweenProfileVisits')
        await igDelay("betweenProfileVisits");

        // f. Return to follower list (back navigation)
        safeEmit(emitter, "info", "Navigating back to followers list...");
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 3000);

        // Resilient Modal State Check
        const modalVisible = await page.locator('div[role="dialog"]').isVisible().catch(() => false);
        if (!modalVisible) {
          safeEmit(emitter, "info", "Followers modal was closed after going back. Re-opening...");
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          await humanDelay(2000, 3000);
          const fLink = await firstVisible(page, [
            'a[href*="/followers/"]',
            'li:has-text("followers") a',
            'span:has-text("followers")'
          ], 5000).catch(() => null);
          if (fLink) {
            await fLink.click();
            await humanDelay(2000, 3000);
            await page.waitForSelector('div[role="dialog"]', { timeout: 10000 }).catch(() => {});
          }
        }
      } catch (err) {
        logger.error("IG_DISCOVERY", `Error processing competitor follower @${username}: ${err.message}`);
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await humanDelay(2000, 3000);
      }
    }

    safeEmit(emitter, "done", `Competitor follower discovery finished. Successfully saved ${savedCount} qualified leads from @${targetAccount}`);
    return { success: true, count: savedCount, leads: savedLeads };

  } catch (err) {
    logger.error("Instagram discoverViaCompetitorFollowers Failed", { targetAccount, error: err.message });
    safeEmit(emitter, "error", `Competitor follower discovery failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  parseIgCount,
  filterBusinessProfile,
  scrapeProfileForLead,
  discoverViaHashtag,
  discoverViaGeolocation,
  discoverViaCompetitorFollowers
};

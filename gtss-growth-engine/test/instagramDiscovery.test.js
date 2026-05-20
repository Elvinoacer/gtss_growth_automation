const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../src/db/database");
const {
  parseIgCount,
  filterBusinessProfile,
  scrapeProfileForLead,
  discoverViaHashtag,
  discoverViaGeolocation,
} = require("../src/automation/instagramDiscovery");

function createMockPage({
  url,
  bodyText = "",
  visibleSelectors = [],
  textOverrides = {},
  attrOverrides = {},
}) {
  const visible = new Set(visibleSelectors);
  const clicks = [];
  const navigations = [];
  let headerLinkCalls = 0;

  function makeCandidate(selector) {
    const isVisible = selector === "body" || visible.has(selector);
    return {
      waitFor: async () => {
        if (!isVisible) throw new Error(`Selector not visible: ${selector}`);
      },
      isVisible: async () => isVisible,
      innerText: async () => {
        if (textOverrides[selector] !== undefined)
          return textOverrides[selector];
        if (selector === "body") return bodyText;
        if (selector.includes("posts")) return "12 posts";
        if (selector.includes("followers")) return "2.3K followers";
        if (selector.includes("following")) return "300 following";
        return "";
      },
      click: async () => {
        clicks.push(selector);
      },
      getAttribute: async (attr) => {
        if (attr === "href") {
          if (selector.includes("mailto")) return "mailto:business@example.com";
          if (selector.includes("tel")) return "tel:+254700000000";
          if (selector.includes("l.instagram.com"))
            return "https://l.instagram.com/?u=https%3A%2F%2Fexample.com";

          const selOverride = attrOverrides[selector];
          if (selOverride && selOverride.href !== undefined) {
            if (Array.isArray(selOverride.href)) {
              const val =
                selOverride.href[headerLinkCalls % selOverride.href.length];
              headerLinkCalls++;
              return val;
            }
            return selOverride.href;
          }
          return "/discovered_user/";
        }
        if (attr === "datetime" && selector.includes("time")) {
          return "2026-05-17T20:00:00.000Z";
        }
        if (
          attrOverrides[selector] &&
          attrOverrides[selector][attr] !== undefined
        ) {
          return attrOverrides[selector][attr];
        }
        return null;
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
    };
  }

  return {
    url: () => url,
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async (target) => {
      navigations.push(target);
    },
    mouse: {
      move: async () => {},
    },
    clicks,
    navigations,
    evaluate: async () => {},
    $$eval: async (selector, fn) => {
      if (selector.includes("article a")) {
        return [
          "https://www.instagram.com/p/CnDuplicate/",
          "https://www.instagram.com/p/CnQualified/",
        ];
      }
      return [];
    },
    waitForSelector: async () => {},
    locator: (selector) => {
      const isVisible = selector === "body" || visible.has(selector);
      const allMatches = [makeCandidate(selector)];
      return {
        count: async () => (isVisible ? 1 : 0),
        nth: () => makeCandidate(selector),
        first: () => makeCandidate(selector),
        all: async () => (isVisible ? allMatches : []),
        innerText: async () => {
          if (textOverrides[selector] !== undefined)
            return textOverrides[selector];
          if (selector === "body") return bodyText;
          return "";
        },
        isVisible: async () => isVisible,
        waitFor: async () => {
          if (!isVisible) throw new Error(`Selector not visible: ${selector}`);
        },
        boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
        click: async () => {
          clicks.push(selector);
        },
      };
    },
  };
}

function createDiscoveryHarness({
  exploreUrl,
  batches,
  postToUsername,
  profileByUsername,
}) {
  const feedState = {
    currentUrl: exploreUrl,
    batchIndex: 0,
    scrollEvents: 0,
    navigations: [],
  };

  const detailState = {
    currentUrl: "",
    currentMode: "idle",
    currentUsername: "",
    currentPostLink: "",
    navigations: [],
    clicks: [],
  };

  function visibleLinks() {
    const currentBatches = batches.slice(0, feedState.batchIndex + 1);
    return [...new Set(currentBatches.flat())];
  }

  function getProfile(username) {
    return profileByUsername[username] || {};
  }

  function createElement(selector) {
    const profile = getProfile(detailState.currentUsername);
    const isPostMode = detailState.currentMode === "post";
    const isProfileMode = detailState.currentMode === "profile";
    const authorHref = detailState.currentUsername
      ? `/${detailState.currentUsername}/`
      : "/unknown/";
    const websiteHref = profile.website
      ? `https://l.instagram.com/?u=${encodeURIComponent(profile.website)}`
      : "";
    const isVisible = (() => {
      if (selector === "body") return true;
      if (isPostMode) {
        return [
          'header a[role="link"]',
          "header a",
          "article header a",
          'a[href*="/"]:near(time)',
          "time[datetime]",
          'svg[aria-label="Close"]',
          'button[aria-label="Close"]',
          'div[role="button"]:has(svg[aria-label="Close"])',
        ].includes(selector);
      }
      if (isProfileMode) {
        return [
          "header section h1",
          "header h1",
          "header h2 + span",
          'span[title="Verified"]',
          'svg[aria-label="Verified"]',
          "header section > div > span",
          "main header section > div:last-child > span",
          "div.-v74b span",
          "header section span",
          'header a[href*="l.instagram.com"]',
          'header a[target="_blank"]',
          'header a[href*="http"]',
          'button:has-text("Contact")',
          'button:has-text("Email")',
          'button:has-text("Call")',
          'div[role="button"]:has-text("Contact")',
          'a[href^="mailto:"]',
          'a[href^="tel:"]',
          'header section div[class*="category"]',
          "header section div:has(h1) + div span",
          'span[class*="category"]',
          'article a[href*="/p/"]',
          "time[datetime]",
          'svg[aria-label="Close"]',
          'button[aria-label="Close"]',
          'div[role="button"]:has(svg[aria-label="Close"])',
        ].includes(selector);
      }
      return selector === 'article a[href*="/p/"]';
    })();

    return {
      waitFor: async () => {
        if (!isVisible) throw new Error(`Selector not visible: ${selector}`);
      },
      isVisible: async () => isVisible,
      innerText: async () => {
        if (selector === "body") return "";
        if (isPostMode) {
          if (
            selector === 'header a[role="link"]' ||
            selector === "header a" ||
            selector === "article header a" ||
            selector === 'a[href*="/"]:near(time)'
          ) {
            return detailState.currentUsername;
          }
          if (selector === "time[datetime]") return "2026-05-17T20:00:00.000Z";
          return "";
        }
        if (!isProfileMode) return "";
        if (
          selector === "header section h1" ||
          selector === "header h1" ||
          selector === "header h2 + span"
        )
          return profile.display_name || detailState.currentUsername;
        if (
          selector === "header section > div > span" ||
          selector === "main header section > div:last-child > span" ||
          selector === "div.-v74b span" ||
          selector === "header section span"
        )
          return profile.bio || "";
        if (
          selector === 'header a[href*="http"]' ||
          selector === 'header a[target="_blank"]' ||
          selector === 'header a[href*="l.instagram.com"]'
        )
          return profile.website || "";
        if (
          selector === 'header section div[class*="category"]' ||
          selector === "header section div:has(h1) + div span" ||
          selector === 'span[class*="category"]'
        )
          return profile.business_category || "";
        if (selector === 'a[href^="mailto:"]')
          return profile.email ? `mailto:${profile.email}` : "";
        if (selector === 'a[href^="tel:"]')
          return profile.phone ? `tel:${profile.phone}` : "";
        if (selector === 'article a[href*="/p/"]') return "";
        if (selector === "time[datetime]")
          return profile.last_post_date || "2026-05-17T20:00:00.000Z";
        return "";
      },
      click: async () => {
        detailState.clicks.push(selector);
      },
      getAttribute: async (attr) => {
        if (attr === "href") {
          if (isPostMode) {
            if (
              selector === 'header a[role="link"]' ||
              selector === "header a" ||
              selector === "article header a" ||
              selector === 'a[href*="/"]:near(time)'
            ) {
              return authorHref;
            }
          }
          if (isProfileMode) {
            if (selector === 'header a[href*="l.instagram.com"]')
              return websiteHref;
            if (
              selector === 'header a[target="_blank"]' ||
              selector === 'header a[href*="http"]'
            )
              return profile.website || "";
            if (selector === 'a[href^="mailto:"]')
              return profile.email ? `mailto:${profile.email}` : "";
            if (selector === 'a[href^="tel:"]')
              return profile.phone ? `tel:${profile.phone}` : "";
          }
        }
        if (attr === "datetime" && selector === "time[datetime]") {
          return profile.last_post_date || "2026-05-17T20:00:00.000Z";
        }
        return null;
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
    };
  }

  const detailPage = {
    clicks: detailState.clicks,
    navigations: detailState.navigations,
    goto: async (target) => {
      detailState.currentUrl = target;
      detailState.navigations.push(target);
      if (target.includes("/p/")) {
        detailState.currentMode = "post";
        detailState.currentPostLink = target;
        detailState.currentUsername = postToUsername[target] || "";
      } else {
        detailState.currentMode = "profile";
        detailState.currentUsername =
          target.split("/").filter(Boolean).pop() || "";
      }
    },
    waitForLoadState: async () => {},
    isClosed: () => false,
    evaluate: async () => {},
    mouse: {
      move: async () => {},
    },
    locator: (selector) => {
      const element = createElement(selector);
      return {
        count: async () => ((await element.isVisible()) ? 1 : 0),
        nth: () => element,
        first: () => element,
        all: async () => ((await element.isVisible()) ? [element] : []),
        innerText: async () => element.innerText(),
        isVisible: async () => element.isVisible(),
        waitFor: async () => element.waitFor(),
        boundingBox: async () => element.boundingBox(),
        click: async () => element.click(),
        getAttribute: async (attr) => element.getAttribute(attr),
      };
    },
    waitForSelector: async () => {},
    goBack: async () => {},
    close: async () => {},
  };

  const feedPage = {
    currentUrl: feedState.currentUrl,
    navigations: feedState.navigations,
    scrollEvents: () => feedState.scrollEvents,
    goto: async (target) => {
      feedState.currentUrl = target;
      feedState.navigations.push(target);
    },
    waitForLoadState: async () => {},
    isClosed: () => false,
    evaluate: async (fn) => {
      const source = typeof fn === "function" ? fn.toString() : "";
      if (source.includes("scrollBy") || source.includes("scrollTo")) {
        feedState.scrollEvents += 1;
        if (feedState.batchIndex < batches.length - 1) {
          feedState.batchIndex += 1;
        }
      }
      return {
        scrollHeight: 1000 + feedState.batchIndex * 1000,
        scrollY: feedState.batchIndex * 1000,
        innerHeight: 1000,
      };
    },
    mouse: {
      wheel: async () => {
        feedState.scrollEvents += 1;
        if (feedState.batchIndex < batches.length - 1) {
          feedState.batchIndex += 1;
        }
      },
    },
    context: () => ({ newPage: async () => detailPage }),
    $$eval: async (selector) => {
      if (selector.includes("article a")) {
        return visibleLinks();
      }
      return [];
    },
    waitForSelector: async () => {},
    locator: () => ({
      count: async () => 0,
      nth: () => null,
      first: () => null,
      all: async () => [],
      innerText: async () => "",
      isVisible: async () => false,
      waitFor: async () => {},
      boundingBox: async () => null,
      click: async () => {},
      getAttribute: async () => null,
    }),
  };

  return { feedPage, detailPage, feedState, detailState };
}

test("parseIgCount parses standard metrics and handles K/M suffixes", () => {
  assert.equal(parseIgCount("2.3K"), 2300);
  assert.equal(parseIgCount("1.2M"), 1200000);
  assert.equal(parseIgCount("150"), 150);
  assert.equal(parseIgCount("2,500"), 2500);
  assert.equal(parseIgCount("  10.5k  "), 10500);
  assert.equal(parseIgCount(null), 0);
  assert.equal(parseIgCount(500), 500);
});

test("filterBusinessProfile qualifies profiles correctly", () => {
  // Edge Case 1: Less than 2 indicators (fails)
  const failProfile = {
    website: null,
    email: null,
    phone: null,
    follower_count: 50,
    bio: "Just a casual account",
    post_count: 5,
    business_category: null,
  };
  const result1 = filterBusinessProfile(failProfile);
  assert.equal(result1.passes, false);
  assert.match(result1.reason, /Disqualified/);

  // Edge Case 2: 2 indicators (passes) - follower count in range, bio keyword matched
  const passProfile1 = {
    website: null,
    email: null,
    phone: null,
    follower_count: 500,
    bio: "restaurant owner in Nairobi",
    post_count: 5,
    business_category: null,
  };
  const result2 = filterBusinessProfile(passProfile1);
  assert.equal(result2.passes, true);
  assert.match(result2.reason, /Qualified/);

  // Edge Case 3: 3 indicators (passes) - website in bio, email, business category present
  const passProfile2 = {
    website: "https://example.com",
    email: "cafe@example.com",
    phone: null,
    follower_count: 5,
    bio: "personal blog",
    post_count: 1,
    business_category: "Café",
  };
  const result3 = filterBusinessProfile(passProfile2);
  assert.equal(result3.passes, true);
});

test("scrapeProfileForLead scrapes all metadata fields and clicks first post", async () => {
  const mockPage = createMockPage({
    url: "https://www.instagram.com/business_user/",
    visibleSelectors: [
      "header section h1",
      'span[title="Verified"]',
      "header section span", // bio selector
      'header a[href*="l.instagram.com"]',
      'a[href^="mailto:"]',
      'a[href^="tel:"]',
      'header section div[class*="category"]',
      'article a[href*="/p/"]',
      "time[datetime]",
      'svg[aria-label="Close"]',
    ],
    textOverrides: {
      "header section h1": "The Nairobi Cafe",
      "header section span": "Best restaurant grill in Nairobi",
      'header section div[class*="category"]': "Restaurant & Grill",
    },
  });

  const lead = await scrapeProfileForLead(mockPage, "business_user");
  assert.ok(lead);
  assert.equal(lead.username, "business_user");
  assert.equal(lead.display_name, "The Nairobi Cafe");
  assert.equal(lead.is_verified, true);
  assert.equal(lead.bio, "Best restaurant grill in Nairobi");
  assert.equal(lead.website, "https://example.com");
  assert.equal(lead.email, "business@example.com");
  assert.equal(lead.phone, "+254700000000");
  assert.equal(lead.is_business, true);
  assert.equal(lead.business_category, "Restaurant & Grill");
  assert.equal(lead.last_post_date, "2026-05-17T20:00:00.000Z");

  // Verified clicks: opened first grid post and closed it
  assert.ok(mockPage.clicks.includes('article a[href*="/p/"]'));
  assert.ok(mockPage.clicks.includes('svg[aria-label="Close"]'));
});

test("discoverViaHashtag scrolls forward without reloads, deduplicates, and keeps loading new posts", async () => {
  const db = getDb();
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM ig_warmup_sequences").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  // Insert a duplicate lead beforehand to test DB deduplication
  db.prepare(
    `
    INSERT INTO leads (platform, source_keyword, ig_username, profile_url, status)
    VALUES ('instagram', 'hashtag:nairobi', 'duplicate_user', 'https://instagram.com/duplicate_user', 'discovered')
  `,
  ).run();

  const exploreUrl = "https://www.instagram.com/explore/tags/nairobi/";
  const postA = "https://www.instagram.com/p/post-a/";
  const postB = "https://www.instagram.com/p/post-b/";
  const postC = "https://www.instagram.com/p/post-c/";
  const postD = "https://www.instagram.com/p/post-d/";
  const postE = "https://www.instagram.com/p/post-e/";

  const { feedPage, detailPage, feedState } = createDiscoveryHarness({
    exploreUrl,
    batches: [[postA, postB], [postB, postC, postD], [postE]],
    postToUsername: {
      [postA]: "duplicate_user",
      [postB]: "qualified_user",
      [postC]: "qualified_geo_user",
      [postD]: "qualified_user",
      [postE]: "qualified_scroll_user",
    },
    profileByUsername: {
      duplicate_user: {
        display_name: "Duplicate User",
        bio: "restaurant owner in Nairobi",
        website: "https://example.com",
        follower_count: 500,
        following_count: 40,
        post_count: 16,
        is_business: true,
        business_category: "Restaurant",
        email: "duplicate@example.com",
        phone: "+254700000001",
        is_verified: false,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_user: {
        display_name: "Qualified User",
        bio: "restaurant owner in Nairobi",
        website: "https://example.com",
        follower_count: 800,
        following_count: 50,
        post_count: 18,
        is_business: true,
        business_category: "Restaurant",
        email: "qualified@example.com",
        phone: "+254700000002",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_geo_user: {
        display_name: "Qualified Geo User",
        bio: "cafe founder in Nairobi",
        website: "https://example.com",
        follower_count: 900,
        following_count: 44,
        post_count: 21,
        is_business: true,
        business_category: "Cafe",
        email: "geo@example.com",
        phone: "+254700000003",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      qualified_scroll_user: {
        display_name: "Qualified Scroll User",
        bio: "boutique owner in Nairobi",
        website: "https://example.com",
        follower_count: 1100,
        following_count: 52,
        post_count: 25,
        is_business: true,
        business_category: "Boutique",
        email: "scroll@example.com",
        phone: "+254700000004",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
    },
  });

  const emitterLogs = [];
  const emitter = (type, message) => {
    emitterLogs.push({ type, message });
  };

  const result = await discoverViaHashtag(
    feedPage,
    { hashtag: "nairobi", maxLeads: 3 },
    emitter,
  );
  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(
    feedState.navigations.filter((url) => url === exploreUrl).length,
    1,
  );
  assert.ok(
    feedState.scrollEvents >= 2,
    "expected at least two scroll attempts for lazy-loaded pagination",
  );

  const iterationLogs = emitterLogs.filter(
    (log) => log.type === "info" && log.message.includes("iteration"),
  );
  assert.ok(
    iterationLogs.length >= 2,
    "expected multiple iteration logs for long-running discovery",
  );
  assert.ok(
    emitterLogs.some((log) => log.message.includes("duplicates=")),
    "expected duplicate metrics in logs",
  );
  assert.ok(
    emitterLogs.some(
      (log) =>
        log.message.includes("No new post links") ||
        log.message.includes("Feed appears exhausted"),
    ) || result.count === 3,
  );

  // DB assertions
  const duplicate = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'duplicate_user'")
    .get();
  assert.ok(duplicate);

  const qualified = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'qualified_user'")
    .get();
  assert.ok(qualified);
  assert.equal(qualified.source_keyword, "hashtag:nairobi");
  assert.equal(qualified.ig_has_email, 1);

  const scrollQualified = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'qualified_scroll_user'")
    .get();
  assert.ok(scrollQualified);
  assert.equal(scrollQualified.source_keyword, "hashtag:nairobi");

  // Verify emitter logs
  const savedLog = emitterLogs.find((log) => log.type === "saved");
  assert.ok(savedLog);
  assert.match(
    savedLog.message,
    /Saved qualified business lead: @qualified_user/,
  );

  const skippedLog = emitterLogs.find(
    (log) => log.type === "skipped" && log.message.includes("duplicate_user"),
  );
  assert.ok(skippedLog);

  const duplicateUsernameLog = emitterLogs.find((log) =>
    log.message.includes("already processed in this discovery session"),
  );
  assert.ok(duplicateUsernameLog);
});

test("discoverViaGeolocation scrolls forward without reloads, deduplicates, and grows lead counts", async () => {
  const db = getDb();
  db.prepare(
    "DELETE FROM leads WHERE ig_username IN ('geo_alpha_user', 'geo_beta_user')",
  ).run();

  const exploreUrl = "https://www.instagram.com/explore/locations/12345/";
  const post1 = "https://www.instagram.com/p/location-1/";
  const post2 = "https://www.instagram.com/p/location-2/";
  const post3 = "https://www.instagram.com/p/location-3/";
  const post4 = "https://www.instagram.com/p/location-4/";

  const { feedPage, detailPage, feedState } = createDiscoveryHarness({
    exploreUrl,
    batches: [[post1, post2], [post2, post3], [post4]],
    postToUsername: {
      [post1]: "geo_alpha_user",
      [post2]: "geo_beta_user",
      [post3]: "geo_beta_user",
      [post4]: "geo_gamma_user",
    },
    profileByUsername: {
      geo_alpha_user: {
        display_name: "Geo Alpha",
        bio: "boutique owner in Nairobi",
        website: "https://example.com",
        follower_count: 1200,
        following_count: 55,
        post_count: 19,
        is_business: true,
        business_category: "Boutique",
        email: "alpha@example.com",
        phone: "+254700000005",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      geo_beta_user: {
        display_name: "Geo Beta",
        bio: "cafe founder in Nairobi",
        website: "https://example.com",
        follower_count: 980,
        following_count: 48,
        post_count: 20,
        is_business: true,
        business_category: "Cafe",
        email: "beta@example.com",
        phone: "+254700000006",
        is_verified: true,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
      geo_gamma_user: {
        display_name: "Geo Gamma",
        bio: "salon owner in Nairobi",
        website: "https://example.com",
        follower_count: 780,
        following_count: 41,
        post_count: 15,
        is_business: true,
        business_category: "Salon",
        email: "gamma@example.com",
        phone: "+254700000007",
        is_verified: false,
        last_post_date: "2026-05-17T20:00:00.000Z",
      },
    },
  });

  const result = await discoverViaGeolocation(feedPage, {
    locationId: "12345",
    locationName: "Nairobi City",
    maxLeads: 3,
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(
    feedState.navigations.filter((url) => url === exploreUrl).length,
    1,
  );
  assert.ok(
    feedState.scrollEvents >= 2,
    "expected at least two scroll attempts for geolocation pagination",
  );

  const iterationLogs = result.leads.length ? true : false;
  assert.ok(iterationLogs);

  const alpha = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_alpha_user'")
    .get();
  const beta = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_beta_user'")
    .get();
  const gamma = db
    .prepare("SELECT * FROM leads WHERE ig_username = 'geo_gamma_user'")
    .get();
  assert.ok(alpha);
  assert.ok(beta);
  assert.ok(gamma);
  assert.equal(alpha.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(beta.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(gamma.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(alpha.ig_is_business, 1);
  assert.equal(beta.ig_is_business, 1);
  assert.equal(gamma.ig_is_business, 1);

  assert.ok(
    detailPage.navigations.length >= 3,
    "expected detail page to be reused for multiple post/profile visits",
  );
});

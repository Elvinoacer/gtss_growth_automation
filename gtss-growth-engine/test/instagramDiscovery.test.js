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
  discoverViaGeolocation
} = require("../src/automation/instagramDiscovery");

function createMockPage({ url, bodyText = "", visibleSelectors = [], textOverrides = {}, attrOverrides = {} }) {
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
        if (textOverrides[selector] !== undefined) return textOverrides[selector];
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
          if (selector.includes("l.instagram.com")) return "https://l.instagram.com/?u=https%3A%2F%2Fexample.com";
          
          const selOverride = attrOverrides[selector];
          if (selOverride && selOverride.href !== undefined) {
            if (Array.isArray(selOverride.href)) {
              const val = selOverride.href[headerLinkCalls % selOverride.href.length];
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
        if (attrOverrides[selector] && attrOverrides[selector][attr] !== undefined) {
          return attrOverrides[selector][attr];
        }
        return null;
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 })
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
      move: async () => {}
    },
    clicks,
    navigations,
    evaluate: async () => {},
    $$eval: async (selector, fn) => {
      if (selector.includes("article a")) {
        return [
          "https://www.instagram.com/p/CnDuplicate/",
          "https://www.instagram.com/p/CnQualified/"
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
          if (textOverrides[selector] !== undefined) return textOverrides[selector];
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
        }
      };
    }
  };
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
    business_category: null
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
    business_category: null
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
    business_category: "Café"
  };
  const result3 = filterBusinessProfile(passProfile2);
  assert.equal(result3.passes, true);
});

test("scrapeProfileForLead scrapes all metadata fields and clicks first post", async () => {
  const mockPage = createMockPage({
    url: "https://www.instagram.com/business_user/",
    visibleSelectors: [
      'header section h1',
      'span[title="Verified"]',
      'header section span', // bio selector
      'header a[href*="l.instagram.com"]',
      'a[href^="mailto:"]',
      'a[href^="tel:"]',
      'header section div[class*="category"]',
      'article a[href*="/p/"]',
      'time[datetime]',
      'svg[aria-label="Close"]'
    ],
    textOverrides: {
      'header section h1': "The Nairobi Cafe",
      'header section span': "Best restaurant grill in Nairobi",
      'header section div[class*="category"]': "Restaurant & Grill"
    }
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

test("discoverViaHashtag navigates grid, deduplicates, and saves qualified leads", async () => {
  const db = getDb();
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM ig_warmup_sequences").run();
  db.prepare("DELETE FROM ig_follow_tracker").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  // Insert a duplicate lead beforehand to test DB deduplication
  db.prepare(`
    INSERT INTO leads (platform, source_keyword, ig_username, profile_url, status)
    VALUES ('instagram', 'hashtag:nairobi', 'duplicate_user', 'https://instagram.com/duplicate_user', 'discovered')
  `).run();

  const mockPage = createMockPage({
    url: "https://www.instagram.com/explore/tags/nairobi/",
    visibleSelectors: [
      'article a[href*="/p/"]', // post grids
      'header a[role="link"]',  // user header link
      'header section h1',
      'header section span', // bio
      'a[href^="mailto:"]'
    ],
    textOverrides: {
      'header section h1': "Nairobi Coffee Shop",
      'header section span': "Premium coffee shop and salon Nairobi owner"
    },
    attrOverrides: {
      'header a[role="link"]': { href: ["/duplicate_user/", "/qualified_user/"] }
    }
  });

  const emitterLogs = [];
  const emitter = (type, message) => {
    emitterLogs.push({ type, message });
  };

  const result = await discoverViaHashtag(mockPage, { hashtag: "nairobi", maxLeads: 5 }, emitter);
  assert.equal(result.success, true);

  // DB assertions
  const duplicate = db.prepare("SELECT * FROM leads WHERE ig_username = 'duplicate_user'").get();
  assert.ok(duplicate);

  const qualified = db.prepare("SELECT * FROM leads WHERE ig_username = 'qualified_user'").get();
  assert.ok(qualified);
  assert.equal(qualified.source_keyword, "hashtag:nairobi");
  assert.equal(qualified.ig_has_email, 1);

  // Verify emitter logs
  const savedLog = emitterLogs.find(log => log.type === "saved");
  assert.ok(savedLog);
  assert.match(savedLog.message, /Saved qualified business lead: @qualified_user/);

  const skippedLog = emitterLogs.find(log => log.type === "skipped" && log.message.includes("duplicate_user"));
  assert.ok(skippedLog);
});

test("discoverViaGeolocation fetches and qualifies leads correctly", async () => {
  const db = getDb();
  db.prepare("DELETE FROM leads WHERE ig_username = 'qualified_geo_user'").run();

  const mockPage = createMockPage({
    url: "https://www.instagram.com/explore/locations/12345/",
    visibleSelectors: [
      'article a[href*="/p/"]',
      'header a[role="link"]',
      'header section h1',
      'header section span',
      'a[href^="mailto:"]'
    ],
    textOverrides: {
      'header section h1': "Nairobi Boutique",
      'header section span': "Trendy boutique shop Nairobi owner"
    },
    attrOverrides: {
      'header a[role="link"]': { href: "/qualified_geo_user/" }
    }
  });

  const result = await discoverViaGeolocation(mockPage, {
    locationId: "12345",
    locationName: "Nairobi City",
    maxLeads: 1
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);

  const lead = db.prepare("SELECT * FROM leads WHERE ig_username = 'qualified_geo_user'").get();
  assert.ok(lead);
  assert.equal(lead.source_keyword, "geolocation:12345:Nairobi City");
  assert.equal(lead.ig_is_business, 1);
});

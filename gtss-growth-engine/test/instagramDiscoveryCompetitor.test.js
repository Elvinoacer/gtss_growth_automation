const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../src/db/database");
const { discoverViaCompetitorFollowers } = require("../src/automation/instagramDiscovery");

function makeMockLocator(selector, clicks, followersList, currentNavUser, indexVal = 0) {
  const self = {
    count: async () => {
      if (selector === 'a[href*="/followers/"]' || selector.includes("followers")) return 1;
      if (selector.includes("following")) return 1;
      if (selector.includes("posts")) return 1;
      if (selector.includes('div[role="dialog"] a[href^="/"][href$="/"]')) return followersList.length;
      if (selector === 'div[role="dialog"] div[style*="overflow-y"], div[role="dialog"] ul, div[role="dialog"] ._is12') return 1;
      if (selector.includes("h1") || selector === "h1") return 1;
      if (selector.includes("span")) return 1;
      if (selector.includes("href") || selector.includes("target") || selector.includes("l.instagram.com") || selector.includes("http")) {
        return currentNavUser === "lead_biz_owner" ? 1 : 0;
      }
      return 0;
    },
    nth: (idx) => makeMockLocator(selector, clicks, followersList, currentNavUser, idx),
    first: () => makeMockLocator(selector, clicks, followersList, currentNavUser, 0),
    all: async () => [self],
    innerText: async () => {
      if (selector === "body") {
        if (currentNavUser === "lead_biz_owner") {
          return "12 posts | 500 followers | 300 following\nrestaurant owner in Nairobi. cafe. website: example.com";
        }
        return "Just a casual account";
      }
      if (selector.includes("followers")) return currentNavUser === "lead_biz_owner" ? "500 followers" : "10 followers";
      if (selector.includes("following")) return currentNavUser === "lead_biz_owner" ? "300 following" : "10 following";
      if (selector.includes("posts")) return currentNavUser === "lead_biz_owner" ? "12 posts" : "1 posts";
      if (selector.includes("h1") || selector === "h1") return currentNavUser || "noise_user";
      if (selector.includes("span")) {
        if (currentNavUser === "lead_biz_owner") {
          return "restaurant owner in Nairobi. cafe. website: example.com";
        }
      }
      return "";
    },
    isVisible: async () => {
      if (selector === 'div[role="dialog"]') return true;
      if (selector === 'a[href*="/followers/"]' || selector.includes("followers")) return true;
      if (selector.includes("following")) return true;
      if (selector.includes("posts")) return true;
      if (selector.includes("h1") || selector === "h1") return true;
      if (selector.includes("span")) return true;
      if (selector.includes("href") || selector.includes("target") || selector.includes("l.instagram.com") || selector.includes("http")) {
        return currentNavUser === "lead_biz_owner";
      }
      return false;
    },
    waitFor: async () => {},
    boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
    click: async () => {
      clicks.push(selector);
    },
    getAttribute: async (attr) => {
      if (attr === "href") {
        if (selector.includes('div[role="dialog"] a[href^="/"][href$="/"]')) {
          return `/${followersList[indexVal]}/`;
        }
        if (selector.includes("l.instagram.com") || selector.includes("http")) {
          return currentNavUser === "lead_biz_owner" ? "https://l.instagram.com/?u=https%3A%2F%2Fexample.com" : null;
        }
        return `/${selector}/`;
      }
      return null;
    },
    evaluate: async () => {}
  };
  return self;
}

function createMockPage({ targetCompetitor, followersList = [] }) {
  const clicks = [];
  const navigations = [];
  let currentNavUser = null;

  return {
    url: () => `https://www.instagram.com/${currentNavUser || targetCompetitor}/`,
    goto: async (url) => {
      navigations.push(url);
      const match = url.match(/instagram\.com\/([^/]+)\/$/);
      if (match) {
        currentNavUser = match[1];
      }
    },
    goBack: async () => {
      currentNavUser = targetCompetitor;
    },
    clicks,
    navigations,
    evaluate: async () => {},
    waitForSelector: async () => {},
    locator: (selector) => {
      return makeMockLocator(selector, clicks, followersList, currentNavUser);
    }
  };
}

test("discoverViaCompetitorFollowers crawls followers, qualifies business leads, and ignores duplicates", async () => {
  const db = getDb();
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DELETE FROM leads").run();
  db.prepare("PRAGMA foreign_keys = ON").run();

  const emitterEvents = [];
  const emitter = (type, message, data) => {
    emitterEvents.push({ type, message, data });
  };

  const followersList = ["lead_biz_owner", "noise_user", "explore", "lead_biz_owner"];
  const page = createMockPage({ targetCompetitor: "competitor1", followersList });

  const result = await discoverViaCompetitorFollowers(page, { targetAccount: "competitor1", maxProfiles: 5 }, emitter);

  assert.equal(result.success, true);
  assert.equal(result.count, 1); // Only lead_biz_owner passes qualification; noise_user fails; explore is filtered system path; duplicates skipped.

  const leads = db.prepare("SELECT * FROM leads WHERE source_keyword = 'competitor_followers:competitor1'").all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].ig_username, "lead_biz_owner");
  assert.equal(leads[0].company, "lead_biz_owner");
});

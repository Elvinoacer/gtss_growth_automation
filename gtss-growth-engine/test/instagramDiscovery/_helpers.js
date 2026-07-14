/**
 * Shared helpers for the instagramDiscovery test suite.
 *
 * Extracted from the original test/instagramDiscovery.test.js monolith
 * (784 lines) so each thematic .test.js file in this directory can re-use
 * the same mock page + discovery harness machinery.
 *
 * Side effects on require: forces the test DB path and TEST_SPEEDUP env.
 *
 * Exports:
 *   - getDb                          — test database handle
 *   - parseIgCount, filterBusinessProfile, scrapeProfileForLead,
 *     discoverViaHashtag, discoverViaGeolocation
 *                                    — the src/automation/instagramDiscovery exports
 *   - createMockPage({...})          — single-profile mock Playwright page
 *   - createDiscoveryHarness({...})  — multi-page feed+detail harness used by
 *                                       the hashtag / geolocation scroll tests
 */

// Force test database environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../../src/db/database");
const {
  parseIgCount,
  filterBusinessProfile,
  scrapeProfileForLead,
  discoverViaHashtag,
  discoverViaGeolocation,
} = require("../../src/automation/instagramDiscovery");

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

module.exports = {
  getDb,
  parseIgCount,
  filterBusinessProfile,
  scrapeProfileForLead,
  discoverViaHashtag,
  discoverViaGeolocation,
  createMockPage,
  createDiscoveryHarness,
};

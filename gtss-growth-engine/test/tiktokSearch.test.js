/**
 * tiktokSearch.test.js — Tests for the TikTok search-page scraper + helpers
 *
 * The DOM-shape helpers (usernameFromHref, parseStatCount, classifyFollowButton,
 * buildSearchUrl) are pure functions — no browser required. The scrapeUserCards
 * and followUserCard functions take a Playwright-like page object; we feed them
 * a minimal stub so we don't need a real browser.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _internal: {
    usernameFromHref,
    parseStatCount,
    buildSearchUrl,
    SEARCH_SELECTORS,
  },
} = require("../src/automation/tiktokSearch");

// ── Pure helpers ────────────────────────────────────────────────────────────

test("buildSearchUrl encodes the query into the TikTok search/users URL", () => {
  assert.equal(
    buildSearchUrl("restaurant owners"),
    "https://www.tiktok.com/search/user?q=restaurant%20owners",
  );
  assert.equal(
    buildSearchUrl("café owners & chefs"),
    "https://www.tiktok.com/search/user?q=caf%C3%A9%20owners%20%26%20chefs",
  );
});

test("buildSearchUrl throws on empty query", () => {
  assert.throws(() => buildSearchUrl(""), /query is required/);
  assert.throws(() => buildSearchUrl("   "), /query is required/);
});

test("usernameFromHref extracts the handle from /@<username> paths", () => {
  assert.equal(usernameFromHref("/@restaurantownersco"), "restaurantownersco");
  assert.equal(usernameFromHref("/@restaurant.owner"), "restaurant.owner");
  assert.equal(usernameFromHref("/@toprise_restaurant"), "toprise_restaurant");
  assert.equal(usernameFromHref("/@user123"), "user123");
});

test("usernameFromHref returns null for non-profile hrefs", () => {
  assert.equal(usernameFromHref("/video/123"), null);
  assert.equal(usernameFromHref("/tag/food"), null);
  assert.equal(usernameFromHref("https://example.com"), null);
  assert.equal(usernameFromHref(""), null);
  assert.equal(usernameFromHref(null), null);
});

test("parseStatCount parses plain numbers, K, and M suffixes", () => {
  assert.equal(parseStatCount("520"), 520);
  assert.equal(parseStatCount("12.1K"), 12100);
  assert.equal(parseStatCount("1.2M"), 1200000);
  assert.equal(parseStatCount("1,234"), 1234);
  assert.equal(parseStatCount("0"), 0);
});

test("parseStatCount returns null for empty / unparseable input", () => {
  assert.equal(parseStatCount(""), null);
  assert.equal(parseStatCount(null), null);
  assert.equal(parseStatCount(undefined), null);
  assert.equal(parseStatCount("abc"), null);
});

test("SEARCH_SELECTORS.followButton prioritizes data-e2e=follow-back", () => {
  // The first selector in the list should be the most stable one — the
  // data-e2e attribute TikTok uses for its own test suite.
  assert.ok(
    SEARCH_SELECTORS.followButton[0].includes('data-e2e="follow-back"'),
    `Expected followButton[0] to target data-e2e="follow-back", got: ${SEARCH_SELECTORS.followButton[0]}`,
  );
});

test("SEARCH_SELECTORS.userCardLink targets anchor tags with /@ hrefs", () => {
  assert.ok(
    SEARCH_SELECTORS.userCardLink[0].includes('href^="/@"'),
    `Expected userCardLink[0] to target /@ hrefs, got: ${SEARCH_SELECTORS.userCardLink[0]}`,
  );
});

// ── scrapeUserCards with a mocked Playwright page ───────────────────────────
//
// We build a tiny fake `page` object that mimics the Playwright methods
// scrapeUserCards actually calls: locator(), and on each locator: count(),
// nth(), getAttribute(), innerText(), allInnerTexts(), waitFor(). This lets
// us verify the scraper's de-duplication, stat-parsing, and follow-state
// classification without spinning up a real browser.

function makeFakePage(cards) {
  // `cards` is an array of card objects: { href, displayName, username, paragraphs, buttonLabel }
  // `paragraphs` is the array of <p> inner texts in DOM order, e.g.
  //   ["Restaurant Owners Collective", "restaurantownersco", "520", "Followers", "·", "3160", "Likes"]
  // `buttonLabel` is the follow button's innerText, e.g. "Follow" or "Following".

  const anchorLocator = {
    count: async () => cards.length,
    nth: (i) => ({
      getAttribute: async (attr) => (attr === "href" ? cards[i].href : null),
      locator: (selector) => {
        // Scoped lookups inside this card's anchor. We simulate the
        // ancestor-walk by returning a locator scoped to card[i].
        if (selector.startsWith("xpath=")) {
          // Treat as "scope to the card container" — return a locator
          // that proxies to card[i]'s fields.
          return {
            first: () => ({
              count: async () => 1,
              innerText: async () => cards[i].displayName || "",
              locator: (sel) => innerLocator(cards[i], sel),
              allInnerTexts: async () => cards[i].paragraphs || [],
            }),
          };
        }
        return innerLocator(cards[i], selector);
      },
    }),
  };

  function innerLocator(card, selector) {
    // Match the selectors scrapeUserCards uses:
    //   'p[class*="weight-bold"]'   → displayName
    //   'p'                          → all <p> texts
    //   'button[data-e2e="follow-back"]' → follow button
    if (selector === 'p[class*="weight-bold"]') {
      return {
        first: () => ({
          innerText: async () => card.displayName || "",
          count: async () => (card.displayName ? 1 : 0),
        }),
      };
    }
    if (selector === "p") {
      return {
        allInnerTexts: async () => card.paragraphs || [],
      };
    }
    if (selector.includes('data-e2e="follow-back"')) {
      return {
        first: () => ({
          count: async () => (card.buttonLabel ? 1 : 0),
          innerText: async () => card.buttonLabel || "",
          getAttribute: async (attr) =>
            attr === "aria-label" ? card.buttonLabel || "" : null,
          click: async () => { card._clicked = true; },
        }),
      };
    }
    // Default: empty locator
    return {
      first: () => ({
        count: async () => 0,
        innerText: async () => "",
        allInnerTexts: async () => [],
        getAttribute: async () => null,
        click: async () => {},
      }),
      count: async () => 0,
      allInnerTexts: async () => [],
    };
  }

  return {
    locator: (selector) => {
      if (selector === SEARCH_SELECTORS.userCardLink[0]) return anchorLocator;
      if (selector.includes("Users")) {
        // usersTab — return a locator that "clicks" but does nothing.
        return {
          count: async () => 0,
          first: () => ({ click: async () => {} }),
        };
      }
      // Default empty locator
      return {
        count: async () => 0,
        nth: () => ({
          getAttribute: async () => null,
          locator: () => innerLocator({}, ""),
        }),
        first: () => ({
          count: async () => 0,
          innerText: async () => "",
          getAttribute: async () => null,
          click: async () => {},
        }),
      };
    },
    // scrapeUserCards calls humanScroll(page) + humanDelay; the latter is
    // a real setTimeout, so we just let it run. humanScroll calls
    // page.mouse.wheel + page.evaluate, which we stub here.
    evaluate: async () => {},
    // humanScroll calls page.mouse.wheel(0, n) — stub it so the test
    // doesn't crash on the missing mouse property.
    mouse: {
      wheel: async () => {},
    },
    url: () => "https://www.tiktok.com/search/user?q=test",
  };
}

test("scrapeUserCards parses a card with display name, username, followers, likes, and Follow button", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");
  const fakePage = makeFakePage([
    {
      href: "/@restaurantownersco",
      displayName: "Restaurant Owners Collective",
      paragraphs: [
        "Restaurant Owners Collective",
        "restaurantownersco",
        "520", "Followers", "·", "3160", "Likes",
      ],
      buttonLabel: "Follow",
    },
  ]);

  const cards = await scrapeUserCards(fakePage, { maxScrolls: 0, maxCards: 10 });
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.username, "restaurantownersco");
  assert.equal(c.displayName, "Restaurant Owners Collective");
  assert.equal(c.profileUrl, "https://www.tiktok.com/@restaurantownersco");
  assert.equal(c.followers, 520);
  assert.equal(c.likes, 3160);
  assert.equal(c.followState, "follow");
});

test("scrapeUserCards classifies 'Following' buttons as already_connected", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");
  const fakePage = makeFakePage([
    {
      href: "/@alreadyfollowed",
      displayName: "Already Followed",
      paragraphs: ["Already Followed", "alreadyfollowed", "100", "Followers", "·", "50", "Likes"],
      buttonLabel: "Following",
    },
  ]);
  const cards = await scrapeUserCards(fakePage, { maxScrolls: 0, maxCards: 10 });
  assert.equal(cards[0].followState, "following");
});

test("scrapeUserCards de-duplicates cards by username across scrolls", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");
  // Same card visible across two scroll passes — should only be collected once.
  const fakePage = makeFakePage([
    {
      href: "/@unique_user",
      displayName: "Unique User",
      paragraphs: ["Unique User", "unique_user", "10", "Followers", "·", "5", "Likes"],
      buttonLabel: "Follow",
    },
  ]);
  const cards = await scrapeUserCards(fakePage, { maxScrolls: 2, maxCards: 10 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].username, "unique_user");
});

test("scrapeUserCards parses K-suffixed follower counts (12.1K)", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");
  const fakePage = makeFakePage([
    {
      href: "/@bigbrand",
      displayName: "Big Brand",
      paragraphs: ["Big Brand", "bigbrand", "12.1K", "Followers", "·", "106.2K", "Likes"],
      buttonLabel: "Follow",
    },
  ]);
  const cards = await scrapeUserCards(fakePage, { maxScrolls: 0, maxCards: 10 });
  assert.equal(cards[0].followers, 12100);
  assert.equal(cards[0].likes, 106200);
});

// ── Regression: page closed mid-scroll ──────────────────────────────────────
//
// Reproduces the "mouse.wheel: Target page, context or browser has been
// closed" failure seen in production. scrapeUserCards should return whatever
// cards it already collected instead of throwing — so the pipeline can
// transition cleanly to "stopping" rather than crashing.

test("scrapeUserCards returns cards collected so far when the page closes mid-scroll", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");
  const fakePage = makeFakePage([
    {
      href: "/@survivor",
      displayName: "Survivor User",
      paragraphs: ["Survivor User", "survivor", "10", "Followers", "·", "5", "Likes"],
      buttonLabel: "Follow",
    },
  ]);
  // Override mouse.wheel to throw the same error Playwright throws when
  // the page is closed mid-scroll.
  fakePage.mouse.wheel = async () => {
    const err = new Error("mouse.wheel: Target page, context or browser has been closed");
    throw err;
  };

  const cards = await scrapeUserCards(fakePage, { maxScrolls: 3, maxCards: 10 });
  // We should still have the 1 card that was scraped before the scroll failed.
  assert.equal(cards.length, 1);
  assert.equal(cards[0].username, "survivor");
});

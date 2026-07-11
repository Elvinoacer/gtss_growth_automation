/**
 * tiktokSearch.test.js — Tests for the TikTok search-page scraper + helpers
 *
 * The DOM-shape helpers (usernameFromHref, parseStatCount, classifyFollowButton,
 * buildSearchUrl) are pure functions — no browser required. The scrapeUserCards
 * and followUserCard functions take a Playwright-like page object; we feed them
 * a minimal stub so we don't need a real browser.
 */

// Speed up humanDelay so the scrape tests don't take 15+ seconds each.
// Other test files in this repo use the same convention.
process.env.TEST_SPEEDUP = "true";

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

// ── Refresh-if-empty guard ─────────────────────────────────────────────────
//
// Reproduces the "page might be empty for these results, just refresh the
// page we reload the results" symptom the user reported. scrapeUserCards
// should call page.reload() when no anchors are visible on the first probe,
// then re-probe. We verify by tracking reload + count calls on a fake page
// that returns 0 anchors on the first count and 1 anchor thereafter.

test("scrapeUserCards reloads the page when no anchors are visible on first paint", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");

  let countCalls = 0;
  let reloadCalls = 0;

  // Build a fake page whose anchor locator returns 0 on the first count()
  // call (the initial probe) and 1 thereafter (after "reload").
  const card = {
    href: "/@refreshed_user",
    displayName: "Refreshed User",
    paragraphs: ["Refreshed User", "refreshed_user", "42", "Followers", "·", "99", "Likes"],
    buttonLabel: "Follow",
  };

  const anchorLocator = {
    count: async () => {
      countCalls += 1;
      // First two count() calls (initial probe + post-hydrate re-probe)
      // return 0. After reload, return 1.
      return countCalls <= 2 ? 0 : 1;
    },
    nth: () => ({
      getAttribute: async (attr) => (attr === "href" ? card.href : null),
      locator: (selector) => {
        if (selector.startsWith("xpath=")) {
          return {
            first: () => ({
              count: async () => 1,
              innerText: async () => card.displayName,
              locator: (sel) => innerLocator(card, sel),
              allInnerTexts: async () => card.paragraphs,
            }),
          };
        }
        return innerLocator(card, selector);
      },
    }),
  };

  function innerLocator(c, selector) {
    if (selector === 'p[class*="weight-bold"]') {
      return { first: () => ({ innerText: async () => c.displayName, count: async () => 1 }) };
    }
    if (selector === "p") {
      return { allInnerTexts: async () => c.paragraphs };
    }
    if (selector.includes('data-e2e="follow-back"')) {
      return {
        first: () => ({
          count: async () => 1,
          innerText: async () => c.buttonLabel,
          getAttribute: async () => c.buttonLabel,
          click: async () => {},
        }),
      };
    }
    if (selector.startsWith("div[")) {
      // Card-container descendant selector — return a non-empty locator so
      // the descendant-scope code path is exercised.
      return {
        first: () => ({
          count: async () => 1,
          locator: (sel) => innerLocator(c, sel),
        }),
      };
    }
    return { first: () => ({ count: async () => 0, innerText: async () => "" }), count: async () => 0 };
  }

  const fakePage = {
    locator: (selector) => {
      if (selector === SEARCH_SELECTORS.userCardLink[0]) return anchorLocator;
      if (selector.includes("Users")) {
        return { count: async () => 0, first: () => ({ click: async () => {} }) };
      }
      return {
        count: async () => 0,
        nth: () => ({ getAttribute: async () => null, locator: () => innerLocator({}, "") }),
        first: () => ({ count: async () => 0, innerText: async () => "", click: async () => {} }),
      };
    },
    reload: async () => { reloadCalls += 1; },
    evaluate: async () => {},
    mouse: { wheel: async () => {} },
    url: () => "https://www.tiktok.com/search/user?q=test",
  };

  const cards = await scrapeUserCards(fakePage, { maxScrolls: 0, maxCards: 10 });
  assert.equal(reloadCalls, 1, `Expected exactly one reload call, got ${reloadCalls}`);
  assert.equal(cards.length, 1, `Expected 1 card after reload, got ${cards.length}`);
  assert.equal(cards[0].username, "refreshed_user");
});

// ── Descendant:: selector regression ────────────────────────────────────────
//
// The previous code used `xpath=ancestor::div[...]` to scope follow-button +
// text lookups to a card container. This was wrong — the container is a
// DESCENDANT of the anchor, not an ancestor. The bug was masked by a silent
// fallback to `anchor` as the scope. After the fix, we use a CSS descendant
// selector. This test verifies that the descendant path actually picks up
// the container (and doesn't fall through to the anchor) when the container
// is present.

test("scrapeUserCards uses the card container as scope when div[data-fmp] is present", async () => {
  const { scrapeUserCards } = require("../src/automation/tiktokSearch");

  // Track whether the descendant container lookup was attempted.
  let containerLookupCount = 0;
  const card = {
    href: "/@scoped_user",
    displayName: "Scoped User",
    paragraphs: ["Scoped User", "scoped_user", "100", "Followers", "·", "50", "Likes"],
    buttonLabel: "Follow",
  };

  const anchorLocator = {
    count: async () => 1,
    nth: () => ({
      getAttribute: async (attr) => (attr === "href" ? card.href : null),
      locator: (selector) => {
        // The new CSS descendant selector starts with "div[" — verify
        // we hit that branch and return a non-empty container locator.
        if (selector.startsWith("div[") || selector.startsWith("div,")) {
          containerLookupCount += 1;
          return {
            first: () => ({
              count: async () => 1,
              locator: (sel) => innerLocator(card, sel),
              innerText: async () => "",
              allInnerTexts: async () => card.paragraphs,
            }),
          };
        }
        return innerLocator(card, selector);
      },
    }),
  };

  function innerLocator(c, selector) {
    if (selector === 'p[class*="weight-bold"]') {
      return { first: () => ({ innerText: async () => c.displayName, count: async () => 1 }) };
    }
    if (selector === "p") {
      return { allInnerTexts: async () => c.paragraphs };
    }
    if (selector.includes('data-e2e="follow-back"')) {
      return {
        first: () => ({
          count: async () => 1,
          innerText: async () => c.buttonLabel,
          getAttribute: async () => c.buttonLabel,
          click: async () => {},
        }),
      };
    }
    return { first: () => ({ count: async () => 0, innerText: async () => "" }), count: async () => 0 };
  }

  const fakePage = {
    locator: (selector) => {
      if (selector === SEARCH_SELECTORS.userCardLink[0]) return anchorLocator;
      if (selector.includes("Users")) {
        return { count: async () => 0, first: () => ({ click: async () => {} }) };
      }
      return {
        count: async () => 0,
        nth: () => ({ getAttribute: async () => null, locator: () => innerLocator({}, "") }),
        first: () => ({ count: async () => 0, innerText: async () => "", click: async () => {} }),
      };
    },
    evaluate: async () => {},
    mouse: { wheel: async () => {} },
    url: () => "https://www.tiktok.com/search/user?q=test",
  };

  const cards = await scrapeUserCards(fakePage, { maxScrolls: 0, maxCards: 10 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].username, "scoped_user");
  assert.equal(cards[0].displayName, "Scoped User");
  assert.ok(
    containerLookupCount > 0,
    `Expected the descendant card-container lookup to be invoked at least once, got ${containerLookupCount}`,
  );
});

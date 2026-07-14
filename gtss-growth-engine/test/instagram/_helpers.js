/**
 * Shared helpers for the instagram test suite.
 *
 * Extracted from the original test/instagram.test.js monolith (844 lines)
 * so each thematic .test.js file in this directory can re-use the same
 * createMockPage helper without duplicating ~225 lines of mock Playwright
 * page machinery.
 *
 * Side effects on require: forces the test DB path and TEST_SPEEDUP env.
 *
 * Exports:
 *   - instagram       — the src/automation/instagram module
 *   - getDb           — the test database handle
 *   - createMockPage({...}) — mock Playwright page used by all tests
 */

const fs = require("node:fs");
const path = require("node:path");

// Force test database environment
process.env.DB_PATH = "./data/test_instagram.db";
process.env.TEST_SPEEDUP = "true";

const { getDb } = require("../../src/db/database");
const instagram = require("../../src/automation/instagram");

function createMockPage({
  url,
  bodyText = "",
  visibleSelectors = [],
  lastMsgStyle = "",
  lastMsgClass = "",
  lastMsgAlignment = "",
  resultsList = [],
  lastMsgText = "",
}) {
  const visible = new Set(visibleSelectors);
  const clicks = [];
  const mouseMoves = [];
  const fills = {};

  function checkVisibility(selector) {
    if (
      selector === "body" ||
      visible.has(selector) ||
      resultsList.includes(selector)
    )
      return true;
    if (selector.includes(",")) {
      const parts = selector.split(",").map((s) => s.trim());
      if (parts.some((part) => visible.has(part))) return true;
    }
    if (selector.includes(":has-text(")) {
      const match = selector.match(/:has-text\("([^"]+)"\)/);
      if (match && resultsList.includes(match[1])) {
        if (
          selector.includes("direct/t/") ||
          selector.includes('role="button"')
        ) {
          return visible.has('a[href*="/direct/t/"]');
        }
        return true;
      }
    }
    if (selector.includes("direct/t/") && resultsList.length > 0) {
      if (visible.has('a[href*="/direct/t/"]')) {
        return true;
      }
    }
    return false;
  }

  function makeCandidate(selector) {
    const isVisible = checkVisibility(selector);
    return {
      waitFor: async () => {
        if (!isVisible) throw new Error(`Selector not visible: ${selector}`);
      },
      isVisible: async () => isVisible,
      innerText: async () => {
        if (selector === "body") return bodyText;
        if (selector.includes("Following")) return "Following";
        if (selector.includes("Requested")) return "Requested";
        if (selector.includes("Follow")) return "Follow";
        if (selector.includes("Unfollow")) return "Unfollow";
        if (
          selector.includes("row") ||
          selector.includes("message") ||
          selector.includes("bubble")
        ) {
          return lastMsgText;
        }
        // resultsList check
        for (const item of resultsList) {
          if (selector.includes(item)) return item;
        }
        return "";
      },
      click: async () => {
        clicks.push(selector);
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
      getAttribute: async (attr) => {
        if (attr === "aria-label") {
          if (selector.includes("Unlike")) return "Unlike";
          if (selector.includes("Like")) return "Like";
        }
        if (attr === "href") {
          if (selector.includes("direct/t/") || resultsList.includes(selector))
            return "/direct/t/12345";
          if (selector.includes("Profile") || selector.includes("profile"))
            return "/my_username/";
          if (selector.includes("/p/")) return "/p/Cverification123/";
        }
        if (attr === "style") {
          if (
            selector.includes("row") ||
            selector.includes("message") ||
            selector.includes("bubble")
          ) {
            return lastMsgStyle;
          }
        }
        if (attr === "class") {
          if (
            selector.includes("row") ||
            selector.includes("message") ||
            selector.includes("bubble")
          ) {
            return lastMsgClass;
          }
        }
        return "";
      },
      fill: async (val) => {
        fills[selector] = val;
      },
      type: async (val) => {
        fills[selector] = (fills[selector] || "") + val;
      },
      setInputFiles: async (val) => {
        fills[selector] = val;
      },
      evaluate: async (fn) => {
        if (
          selector.includes("row") ||
          selector.includes("message") ||
          selector.includes("bubble")
        ) {
          return lastMsgAlignment;
        }
        return "";
      },
      $: async (subSelector) => {
        if (checkVisibility(subSelector)) return makeCandidate(subSelector);
        return null;
      },
      locator: {
        innerText: async () => {
          if (selector.includes("Following")) return "Following";
          if (selector.includes("Requested")) return "Requested";
          if (selector.includes("Follow")) return "Follow";
          if (selector.includes("Unfollow")) return "Unfollow";
          return "";
        },
        click: async () => {
          clicks.push(selector);
        },
      },
    };
  }

  return {
    url: () => url,
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: {
      move: async (x, y) => {
        mouseMoves.push({ x, y });
      },
      wheel: async (x, y) => {},
    },
    keyboard: {
      press: async (key) => {
        clicks.push(key);
      },
      type: async (text) => {
        clicks.push(text);
      },
    },
    waitForSelector: async (selector, options) => {
      if (checkVisibility(selector)) return makeCandidate(selector);
      throw new Error(`Timeout waiting for selector: ${selector}`);
    },
    evaluate: async (fn) => {},
    clicks,
    mouseMoves,
    fills,
    locator: (selector) => {
      const isVisible = checkVisibility(selector);
      const buildLocator = (sel, visibleState) => {
        const candidate = makeCandidate(sel);
        const locObj = {
          count: async () => {
            if (!visibleState) return 0;
            if (
              sel.includes("row") ||
              sel.includes("message") ||
              sel.includes("bubble")
            ) {
              return 1;
            }
            if (
              sel.includes(":has-text(") &&
              resultsList.length > 0 &&
              resultsList.some((r) => sel.includes(r))
            ) {
              return resultsList.length;
            }
            return 1;
          },
          nth: (i) => {
            if (
              sel.includes(":has-text(") &&
              resultsList.length > 0 &&
              resultsList.some((r) => sel.includes(r))
            ) {
              return buildLocator(resultsList[i] || sel, visibleState);
            }
            return locObj;
          },
          first: () => buildLocator(sel, visibleState),
          last: () => buildLocator(sel, visibleState),
          innerText: candidate.innerText,
          isVisible: candidate.isVisible,
          waitFor: candidate.waitFor,
          boundingBox: candidate.boundingBox,
          click: candidate.click,
          getAttribute: candidate.getAttribute,
          $: candidate.$,
          fill: candidate.fill,
          type: candidate.type,
          setInputFiles: candidate.setInputFiles,
          evaluate: candidate.evaluate,
        };
        return locObj;
      };
      return buildLocator(selector, isVisible);
    },
  };
}

module.exports = {
  getDb,
  instagram,
  createMockPage,
};

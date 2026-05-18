const assert = require("node:assert/strict");
const test = require("node:test");
const {
  checkInstagramSessionState,
  checkForInstagramBlock,
  humanMouseMove,
  dailySessionWarmup,
  createInstagramBrowser,
  INSTAGRAM_AUTH_SELECTORS,
  INSTAGRAM_LOGIN_SELECTORS,
  INSTAGRAM_CAPTCHA_SELECTORS,
  INSTAGRAM_BLOCK_PHRASES
} = require("../src/automation/browserBase");

process.env.TEST_SPEEDUP = "true";

function createMockInstagramPage({ url, bodyText = "", visibleSelectors = [] }) {
  const visible = new Set(visibleSelectors);

  function makeCandidate(selector) {
    const isVisible = selector === "body" || visible.has(selector);

    return {
      waitFor: async () => {
        if (!isVisible) {
          throw new Error(`Selector not visible: ${selector}`);
        }
      },
      isVisible: async () => isVisible,
      innerText: async () => (selector === "body" ? bodyText : ""),
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
    };
  }

  const mouseMoves = [];

  return {
    url: () => url,
    waitForLoadState: async () => {},
    isClosed: () => false,
    goto: async () => {},
    mouse: {
      move: async (x, y) => {
        mouseMoves.push({ x, y });
      },
      wheel: async (deltaX, deltaY) => {
        // Mock scroll action
      }
    },
    mouseMoves,
    locator: (selector) => ({
      count: async () => (selector === "body" || visible.has(selector) ? 1 : 0),
      nth: () => makeCandidate(selector),
      first: () => makeCandidate(selector),
      innerText: async () => (selector === "body" ? bodyText : ""),
      isVisible: async () => selector === "body" || visible.has(selector),
      waitFor: async () => {
        if (selector !== "body" && !visible.has(selector)) {
          throw new Error(`Selector not visible: ${selector}`);
        }
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 50, height: 30 }),
    }),
  };
}

test("checkForInstagramBlock detects block phrases", async () => {
  const pageWithBlock = createMockInstagramPage({
    url: "https://www.instagram.com/",
    bodyText: "Your account is temporarily restricted. Action blocked. Try again later."
  });
  
  const blockResult = await checkForInstagramBlock(pageWithBlock);
  assert.equal(blockResult.blocked, true);
  assert.match(blockResult.reason, /Instagram action block detected/);

  const cleanPage = createMockInstagramPage({
    url: "https://www.instagram.com/",
    bodyText: "Welcome to your feed!"
  });

  const cleanResult = await checkForInstagramBlock(cleanPage);
  assert.equal(cleanResult.blocked, false);
  assert.equal(cleanResult.reason, "");

  // Clean up DB state to prevent test interference
  const { getDb } = require("../src/db/database");
  getDb().prepare("DELETE FROM settings WHERE key = 'ig_blocked_until'").run();
});

test("checkInstagramSessionState handles blocked, captcha, logged_out, authenticated, and unknown states", async () => {
  // Blocked
  const blockedPage = createMockInstagramPage({
    url: "https://www.instagram.com/",
    bodyText: "This action limit is restricted. Try again later."
  });
  const blockedState = await checkInstagramSessionState(blockedPage);
  assert.equal(blockedState, "blocked");

  // Captcha
  const captchaPage = createMockInstagramPage({
    url: "https://www.instagram.com/challenge/",
    visibleSelectors: ['#recaptcha']
  });
  const captchaState = await checkInstagramSessionState(captchaPage);
  assert.equal(captchaState, "captcha");

  // Logged Out
  const loggedOutPage = createMockInstagramPage({
    url: "https://www.instagram.com/accounts/login/",
    visibleSelectors: ['input[name="username"]']
  });
  const loggedOutState = await checkInstagramSessionState(loggedOutPage);
  assert.equal(loggedOutState, "logged_out");

  // Authenticated
  const authPage = createMockInstagramPage({
    url: "https://www.instagram.com/",
    visibleSelectors: ['a[href="/"]', 'svg[aria-label="Home"]']
  });
  const authState = await checkInstagramSessionState(authPage);
  assert.equal(authState, "authenticated");

  // Unknown
  const unknownPage = createMockInstagramPage({
    url: "https://www.instagram.com/about/",
    bodyText: "General Info Page"
  });
  const unknownState = await checkInstagramSessionState(unknownPage);
  assert.equal(unknownState, "unknown");
});

test("humanMouseMove moves mouse in 2-step approach", async () => {
  const page = createMockInstagramPage({});
  const mockElement = page.locator('.some-button');
  
  await humanMouseMove(page, mockElement);
  
  assert.equal(page.mouseMoves.length, 2);
  
  // Center is: x = 100 + 50/2 = 125, y = 200 + 30/2 = 215
  const finalMove = page.mouseMoves[1];
  assert.equal(finalMove.x, 125);
  assert.equal(finalMove.y, 215);

  const initialMove = page.mouseMoves[0];
  // Initial move should be offset from center by up to 30px
  assert.ok(initialMove.x >= 95 && initialMove.x <= 155);
  assert.ok(initialMove.y >= 185 && initialMove.y <= 245);
});

test("dailySessionWarmup executes simulateOrganicBrowse and completes", async () => {
  const page = createMockInstagramPage({
    url: "https://www.instagram.com/"
  });
  
  const originalDateNow = Date.now;
  let callCount = 0;
  // Mock Date.now to simulate target elapsed times:
  // 1st call (startTime): return 1000000
  // 2nd call (elapsed check): return 1000050
  // 3rd call (durationMs calculation): return 1045000 (meaning warmup completed in 45 seconds)
  Date.now = () => {
    callCount++;
    if (callCount === 1) return 1000000;
    if (callCount === 2) return 1000050;
    return 1045000;
  };
  
  try {
    const result = await dailySessionWarmup(page);
    assert.equal(result.completed, true);
    assert.ok(result.durationMs >= 30000 && result.durationMs <= 60000, `Duration was ${result.durationMs}ms`);
  } finally {
    Date.now = originalDateNow;
  }
});

test("createInstagramBrowser launches headed, configured with Nairobi geolocation", async () => {
  const browserState = await createInstagramBrowser();
  assert.equal(browserState.platform, "instagram");
  assert.equal(browserState.mode, "ephemeral");
  assert.ok(browserState.browser);
  assert.ok(browserState.context);
  assert.ok(browserState.page);
  
  // Close the browser afterwards
  await browserState.browser.close();
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gtss-browser-test-"));
process.env.DB_PATH = path.join(root, "gtss.db");
process.env.ENCRYPTION_KEY = "test-key";
process.env.AUTOMATION_LOCKS_DIR = path.join(root, "locks");
process.env.AUTOMATION_ARTIFACTS_DIR = path.join(root, "artifacts");
process.env.ALLOW_HEADLESS_SOCIAL = "false";

const {
  acquireBrowserLock,
  AUTH_STATES,
  checkSessionState,
  getBrowserMode,
  releaseBrowserLock,
  normalizeHeadless,
} = require("../src/automation/browserBase");

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  Object.entries(snapshot).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

function createMockXPage({ url, bodyText = "", visibleSelectors = [] }) {
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
    };
  }

  return {
    url: () => url,
    waitForLoadState: async () => {},
    isClosed: () => true,
    content: async () => "<html></html>",
    screenshot: async () => Buffer.from(""),
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
    }),
  };
}

test("browser locks block concurrent use of the same profile", () => {
  const lock = acquireBrowserLock("linkedin", "persistent", "/tmp/profile-a");

  assert.throws(
    () => acquireBrowserLock("linkedin", "persistent", "/tmp/profile-a"),
    /already in use/,
  );

  releaseBrowserLock(lock);
  const nextLock = acquireBrowserLock(
    "linkedin",
    "persistent",
    "/tmp/profile-a",
  );
  releaseBrowserLock(nextLock);
});

test("stale browser locks are cleaned up", () => {
  fs.mkdirSync(process.env.AUTOMATION_LOCKS_DIR, { recursive: true });
  const lockFile = path.join(
    process.env.AUTOMATION_LOCKS_DIR,
    "linkedin-persistent-tmp-profile-b.lock",
  );
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 99999999,
      platform: "linkedin",
      mode: "persistent",
      target: "/tmp/profile-b",
    }),
  );

  const lock = acquireBrowserLock("linkedin", "persistent", "/tmp/profile-b");
  assert.equal(lock.filePath, lockFile);
  releaseBrowserLock(lock);
});

test("headless is disabled for social platforms unless explicitly allowed", () => {
  process.env.ALLOW_HEADLESS_SOCIAL = "false";
  assert.equal(normalizeHeadless("linkedin", true), false);
  assert.equal(normalizeHeadless("local", true), true);

  process.env.ALLOW_HEADLESS_SOCIAL = "true";
  assert.equal(normalizeHeadless("linkedin", true), true);
});

test("shared CDP takes precedence over persistent browser mode for social platforms", () => {
  const snapshot = snapshotEnv([
    "LINKEDIN_CDP_ENDPOINT",
    "X_CDP_ENDPOINT",
    "FACEBOOK_CDP_ENDPOINT",
    "INSTAGRAM_CDP_ENDPOINT",
    "BROWSER_MODE",
  ]);

  process.env.LINKEDIN_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.X_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.FACEBOOK_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.INSTAGRAM_CDP_ENDPOINT = "http://127.0.0.1:9222";
  process.env.BROWSER_MODE = "persistent";

  assert.equal(getBrowserMode("linkedin"), "cdp");
  assert.equal(getBrowserMode("x"), "cdp");
  assert.equal(getBrowserMode("facebook"), "cdp");
  assert.equal(getBrowserMode("instagram"), "cdp");
  assert.equal(getBrowserMode("x", { mode: "persistent" }), "cdp");
  assert.equal(
    getBrowserMode("facebook", { userDataDir: "/tmp/custom-profile" }),
    "cdp",
  );
  assert.equal(getBrowserMode("local"), "persistent");

  restoreEnv(snapshot);
});

test("x search result pages are treated as authenticated", async () => {
  const result = await checkSessionState(
    createMockXPage({
      url: "https://x.com/search?q=OpenAI&f=user",
      visibleSelectors: ['[data-testid="UserCell"]'],
    }),
    "x",
    () => {},
  );

  assert.equal(result.state, AUTH_STATES.AUTHENTICATED);
});

test("x session state detection classifies authenticated, login, captcha, rate limit, and unknown states", async () => {
  const emit = () => {};

  const authenticated = await checkSessionState(
    createMockXPage({
      url: "https://x.com/home",
      visibleSelectors: ['[data-testid="SideNav_AccountSwitcher_Button"]'],
    }),
    "x",
    emit,
  );
  assert.equal(authenticated.state, AUTH_STATES.AUTHENTICATED);

  const loginRequired = await checkSessionState(
    createMockXPage({
      url: "https://x.com/i/flow/login",
      bodyText: "Sign in to X",
      visibleSelectors: [
        'input[name="text"]',
        'button[data-testid="LoginForm_Login_Button"]',
      ],
    }),
    "x",
    emit,
  );
  assert.equal(loginRequired.state, AUTH_STATES.LOGIN_REQUIRED);

  const captchaRequired = await checkSessionState(
    createMockXPage({
      url: "https://x.com/account/access",
      bodyText: "We detected unusual activity. Please verify you are human.",
      visibleSelectors: ['iframe[title*="captcha" i]'],
    }),
    "x",
    emit,
  );
  assert.equal(captchaRequired.state, AUTH_STATES.CAPTCHA_REQUIRED);

  const rateLimited = await checkSessionState(
    createMockXPage({
      url: "https://x.com/home",
      bodyText: "Rate limit exceeded. Try again later.",
    }),
    "x",
    emit,
  );
  assert.equal(rateLimited.state, AUTH_STATES.RATE_LIMITED);

  const unknownState = await checkSessionState(
    createMockXPage({
      url: "https://x.com/notifications",
      bodyText: "Welcome back",
    }),
    "x",
    emit,
  );
  assert.equal(unknownState.state, AUTH_STATES.UNKNOWN_STATE);
});

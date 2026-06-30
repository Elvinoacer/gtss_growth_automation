const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { chromium } = require("playwright");

const { __private } = require("../src/automation/linkedin");
const {
  isStrayTabUrl,
  installStrayTabInterceptor,
  closeStrayTabs,
} = require("../src/automation/browserBase");

const browserPath = chromium.executablePath();
const browserMissing = !fs.existsSync(browserPath);
const SKIP = browserMissing
  ? `Playwright browser binary is not installed at ${browserPath}`
  : false;

// ─── 1. forceClearDmDraft clears a stale "Hi Letrise" draft ──────────────────

test(
  "forceClearDmDraft clears a stale 'Hi Letrise' draft left by a previous recipient",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Simulate a LinkedIn DM editor pre-populated with a stale draft.
      await page.setContent(`
        <main></main>
        <section class="msg-overlay-conversation-bubble" role="dialog"
                 style="display:block;width:500px;height:400px;">
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true"
                 aria-label="Write a message"
                 style="display:block;width:440px;height:200px;border:1px solid #ddd;">Hi Letrise,

Thanks for connecting! I'd love to chat about your work.</div>
          </form>
        </section>
      `);

      const editor = page.locator(".msg-form__contenteditable").first();

      // Verify the stale draft is present before clearing.
      const beforeText = await editor.innerText();
      assert.match(beforeText, /Hi Letrise/);

      // Clear the draft.
      const cleared = await __private.forceClearDmDraft(page, editor, {
        maxAttempts: 3,
      });
      assert.equal(cleared, true, "forceClearDmDraft should return true");

      // Verify the editor is now empty.
      const afterText = (await editor.innerText()).trim();
      assert.equal(
        afterText,
        "",
        "Editor must be empty after forceClearDmDraft",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── 2. forceClearDmDraft returns true when editor is already empty ─────────

test(
  "forceClearDmDraft returns true when the editor is already empty (no-op case)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main></main>
        <section class="msg-overlay-conversation-bubble" role="dialog"
                 style="display:block;width:500px;height:400px;">
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true"
                 aria-label="Write a message"
                 style="display:block;width:440px;height:200px;border:1px solid #ddd;"></div>
          </form>
        </section>
      `);

      const editor = page.locator(".msg-form__contenteditable").first();
      const cleared = await __private.forceClearDmDraft(page, editor, {
        maxAttempts: 3,
      });
      assert.equal(cleared, true);
    } finally {
      await browser.close();
    }
  },
);

// ─── 3. typeLikeHuman does NOT preserve stale draft (clears + types new) ────

test(
  "typeLikeHuman clears stale draft and types the new (correct) message",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main></main>
        <section class="msg-overlay-conversation-bubble" role="dialog"
                 style="display:block;width:500px;height:400px;">
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true"
                 aria-label="Write a message"
                 style="display:block;width:440px;height:200px;border:1px solid #ddd;">Hi Letrise,

Stale draft from previous recipient.</div>
          </form>
        </section>
      `);

      const editor = page.locator(".msg-form__contenteditable").first();

      // Type Mike's message — this must NOT result in "Hi Letrise" being sent.
      const mikeMessage = "Hi Mike,\n\nFollowing up on our chat.";
      const ok = await __private.typeLikeHuman(page, editor, mikeMessage);

      assert.equal(ok, true, "typeLikeHuman should succeed");

      const finalText = await editor.innerText();
      assert.match(
        finalText,
        /Hi Mike/,
        "Editor must contain Mike's greeting after typeLikeHuman",
      );
      assert.doesNotMatch(
        finalText,
        /Hi Letrise/,
        "Editor must NOT contain the previous recipient's greeting",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── 4. typeLikeHuman rejects empty text ─────────────────────────────────────

test("typeLikeHuman returns false for empty text", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div contenteditable="true"></div>`);
    const editor = page.locator("div").first();
    const ok = await __private.typeLikeHuman(page, editor, "");
    assert.equal(ok, false);
  } finally {
    await browser.close();
  }
});

// ─── 5. isStrayTabUrl correctly classifies URLs ──────────────────────────────

test("isStrayTabUrl correctly classifies known stray and non-stray URLs", () => {
  // Stray URLs (should return true)
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/hiring/jobs/job-posting/123"),
    true,
  );
  assert.equal(
    isStrayTabUrl(
      "https://www.linkedin.com/talent/job-posting-redirect/?trk=nav_spotlight_post_job",
    ),
    true,
  );
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/jobs/view/4344365383/"),
    true,
  );
  assert.equal(isStrayTabUrl("https://www.linkedin.com/jobs/?start=0"), true);
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/messaging/compose/?thread=123"),
    true,
  );
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/messaging/thread/123/"),
    true,
  );

  // Non-stray URLs (should return false)
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/in/mike-smith/"),
    false,
    "Profile URL must NOT be classified as stray",
  );
  assert.equal(
    isStrayTabUrl("https://www.linkedin.com/feed/"),
    false,
    "Feed URL must NOT be classified as stray",
  );
  assert.equal(isStrayTabUrl("about:blank"), false);
  assert.equal(isStrayTabUrl(""), false);
  assert.equal(isStrayTabUrl(null), false);
  assert.equal(isStrayTabUrl(undefined), false);
});

// ─── 6. installStrayTabInterceptor closes a popup that navigates to /job-posting

test(
  "installStrayTabInterceptor closes a popup that navigates to /talent/job-posting-redirect",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    try {
      // Serve a fake job-posting page at the stray URL.
      await context.route(
        "**/talent/job-posting-redirect**",
        (route) => {
          route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<html><body>Job Posting Upsell</body></html>",
          });
        },
      );

      // Install the interceptor.
      installStrayTabInterceptor(context, "linkedin");

      // Open a main page first (so we're not the only page in the context).
      const mainPage = await context.newPage();
      await mainPage.setContent("<html><body>Main</body></html>");

      // Open a popup that navigates to a stray URL.
      const popupPromise = context.waitForEvent("page", { timeout: 5000 });
      await mainPage.evaluate(() => {
        window.open(
          "https://www.linkedin.com/talent/job-posting-redirect/?trk=nav_spotlight_post_job",
          "_blank",
        );
      });
      const popup = await popupPromise;

      // Give the interceptor time to fire and close the popup.
      await new Promise((r) => setTimeout(r, 2000));

      // The popup should have been closed.
      assert.equal(
        popup.isClosed(),
        true,
        "Popup navigating to /talent/job-posting-redirect must be closed by the interceptor",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── 7. installStrayTabInterceptor does NOT close a popup to a profile URL ──

test(
  "installStrayTabInterceptor does NOT close a popup that navigates to a /in/ profile URL",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    try {
      await context.route("**/in/mike-smith**", (route) => {
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><body>Mike's Profile</body></html>",
        });
      });

      installStrayTabInterceptor(context, "linkedin");

      const mainPage = await context.newPage();
      await mainPage.setContent("<html><body>Main</body></html>");

      const popupPromise = context.waitForEvent("page", { timeout: 5000 });
      await mainPage.evaluate(() => {
        window.open("https://www.linkedin.com/in/mike-smith/", "_blank");
      });
      const popup = await popupPromise;

      // Give the interceptor time to (not) fire.
      await new Promise((r) => setTimeout(r, 1500));

      // The popup should still be open.
      assert.equal(
        popup.isClosed(),
        false,
        "Popup to a /in/ profile URL must NOT be closed by the interceptor",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── 8. installStrayTabInterceptor is idempotent (calling twice doesn't double-register)

test("installStrayTabInterceptor is idempotent — calling twice replaces the handler", () => {
  // Create a minimal fake context with on/off and a tag property.
  let handlerCount = 0;
  const fakeContext = {
    _handlers: new Set(),
    on(_event, handler) {
      this._handlers.add(handler);
      handlerCount++;
    },
    off(_event, handler) {
      this._handlers.delete(handler);
      handlerCount--;
    },
  };

  // Install twice — the second call should remove the first handler.
  installStrayTabInterceptor(fakeContext, "linkedin");
  const handlersAfterFirst = fakeContext._handlers.size;
  installStrayTabInterceptor(fakeContext, "linkedin");
  const handlersAfterSecond = fakeContext._handlers.size;

  assert.equal(
    handlersAfterFirst,
    1,
    "First install should register exactly one handler",
  );
  assert.equal(
    handlersAfterSecond,
    1,
    "Second install should replace the first (not add a second)",
  );
});

// ─── 9. closeStrayTabs closes /job-posting tabs but preserves profile tab ───

test(
  "closeStrayTabs closes /job-posting tabs and preserves the /in/ profile tab",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    try {
      // Stub routes for stray + non-stray URLs.
      await context.route("**/in/mike-smith**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><body>Profile</body></html>",
        }),
      );
      await context.route("**/jobs/job-posting/123**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><body>Job Posting</body></html>",
        }),
      );

      // Open the "main" tab (index 0) — should never be closed.
      const mainPage = await context.newPage();
      await mainPage.goto("https://www.linkedin.com/in/mike-smith/");

      // Open a stray tab.
      const strayPage = await context.newPage();
      await strayPage.goto(
        "https://www.linkedin.com/hiring/jobs/job-posting/123",
      );

      // Confirm both tabs exist before cleanup.
      assert.equal(context.pages().length, 2);

      const closedCount = await closeStrayTabs(context, "linkedin");
      assert.equal(closedCount, 1, "closeStrayTabs should close exactly 1 tab");

      // The stray tab should be closed; the main tab should still be open.
      assert.equal(
        strayPage.isClosed(),
        true,
        "Stray /job-posting tab must be closed",
      );
      assert.equal(
        mainPage.isClosed(),
        false,
        "Main /in/ profile tab must NOT be closed",
      );
    } finally {
      await browser.close();
    }
  },
);

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { chromium } = require("playwright");

const { __private } = require("../src/automation/linkedin");

const browserPath = chromium.executablePath();
const browserMissing = !fs.existsSync(browserPath);
const SKIP = browserMissing
  ? `Playwright browser binary is not installed at ${browserPath}`
  : false;

// Helper: serve HTML at a given URL via context.route(), then navigate to it.
async function serveHtml(context, url, html) {
  await context.route(url, (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html,
    });
  });
}

// ─── test 1: full-page /messaging/ URL → page mode ──────────────────────────

test(
  "detectMessagingContext returns mode=page when URL contains /messaging/",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/messaging/compose**",
        `<html><body><main>
          <div contenteditable="true" aria-label="Write a message"
               style="display:block;width:400px;height:200px;"></div>
        </main></body></html>`,
      );
      await page.goto("https://www.linkedin.com/messaging/compose/?thread=123");

      const result = await __private.detectMessagingContext(page, 1500);
      assert.equal(result.mode, "page");
      assert.equal(result.frame, null);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 2: legacy .msg-form editor in main page → shadow mode (page ctx) ──

test(
  "detectMessagingContext returns mode=shadow when a legacy .msg-form editor is in the main page",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body>
          <main></main>
          <section class="msg-overlay-conversation-bubble" role="dialog" style="display:block;width:500px;height:400px;">
            <form class="msg-form" style="display:block;">
              <div class="msg-form__contenteditable" contenteditable="true" aria-label="Write a message"
                   style="display:block;width:440px;height:200px;"></div>
              <button class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
            </form>
          </section>
        </body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      const result = await __private.detectMessagingContext(page, 1500);
      assert.equal(
        result.mode,
        "shadow",
        `expected shadow mode for legacy .msg-form editor, got ${result.mode} (${result.reason})`,
      );
      assert.equal(result.frame, null);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 3: empty #interop-outlet does NOT trigger shadow mode (regression) ─
//
// This is the core regression test for the bug we fixed. The OLD code did:
//     page.locator('#interop-outlet').isVisible()
// which ALWAYS returned true (because #interop-outlet is permanently visible
// in the DOM per profile.html). This caused the iframe branch to NEVER be
// taken, even when LinkedIn was actually rendering inside the iframe.
//
// The new detectMessagingContext() must NOT pick shadow mode just because
// #interop-outlet exists — it must verify the editor is actually inside it.

test(
  "detectMessagingContext does NOT pick shadow mode for an EMPTY #interop-outlet (regression)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body>
          <main><h1>Some Profile</h1></main>
          <div id="interop-outlet" data-testid="interop-shadowdom"
               style="width:100vw;position:absolute;z-index:500;visibility:visible;">
          </div>
          <iframe data-testid="interop-iframe"
                  src="about:blank"
                  style="opacity:0;z-index:-1;width:100vw;height:100vh;position:absolute;top:0;"
                  tabindex="-1"></iframe>
        </body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      // No messaging UI mounted — should time out and return mode=page.
      const result = await __private.detectMessagingContext(page, 800);
      assert.equal(
        result.mode,
        "page",
        `expected page mode (timeout fallback) for empty interop-outlet, got ${result.mode} (${result.reason})`,
      );
      assert.match(result.reason, /timeout/i);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 4: editor INSIDE #interop-outlet → shadow mode ────────────────────

test(
  "detectMessagingContext returns mode=shadow when an editor is inside #interop-outlet",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body>
          <main></main>
          <div id="interop-outlet" data-testid="interop-shadowdom" style="display:block;">
            <div contenteditable="true" aria-label="Write a message"
                 style="display:block;width:400px;height:200px;"></div>
          </div>
        </body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      const result = await __private.detectMessagingContext(page, 1500);
      assert.equal(result.mode, "shadow");
      assert.match(result.reason, /interop-outlet/i);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 5: editor inside a /preload/ iframe → iframe mode (production case) ─
//
// This reproduces the actual production failure: LinkedIn renders the compose
// UI inside data-testid="interop-iframe" (which stays at /preload/?_bprMode=vanilla
// via postMessage). The OLD code never detected this and used page context,
// causing all keyboard input to be silently dropped.

test(
  "detectMessagingContext returns mode=iframe when an editor is inside a /preload/ iframe (production case)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      // Serve the iframe's /preload/ content with an editor inside.
      await serveHtml(
        context,
        "**/preload/**",
        `<html><body>
          <div contenteditable="true" aria-label="Write a message"
               style="display:block;width:400px;height:200px;"></div>
          <button aria-label="Send" type="submit">Send</button>
        </body></html>`,
      );

      // Serve the main profile page with the interop iframe pointing to /preload/.
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body>
          <main><h1>Some Profile</h1></main>
          <div id="interop-outlet" data-testid="interop-shadowdom"
               style="width:100vw;visibility:visible;"></div>
          <iframe data-testid="interop-iframe"
                  src="/preload/?_bprMode=vanilla"
                  style="width:100vw;height:100vh;position:absolute;top:0;"></iframe>
        </body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      // Wait for the iframe to load and have the editor visible.
      await page
        .frameLocator('[data-testid="interop-iframe"]')
        .locator('[contenteditable="true"]')
        .waitFor({ state: "visible", timeout: 3000 });

      const result = await __private.detectMessagingContext(page, 3000);
      assert.equal(
        result.mode,
        "iframe",
        `expected iframe mode for editor inside /preload/ iframe, got ${result.mode} (${result.reason})`,
      );
      assert.ok(result.frame, "iframe mode must return a frame reference");
    } finally {
      await browser.close();
    }
  },
);

// ─── test 6: iframe navigated to /messaging/compose → iframe mode ───────────

test(
  "detectMessagingContext returns mode=iframe when a frame URL contains /messaging/compose",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/messaging/compose**",
        `<html><body>
          <div contenteditable="true" aria-label="Write a message"
               style="display:block;width:400px;height:200px;"></div>
        </body></html>`,
      );
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body>
          <main><h1>Some Profile</h1></main>
          <iframe src="/messaging/compose/?recipient=ABC123"
                  style="width:100vw;height:100vh;"></iframe>
        </body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      await page
        .frameLocator("iframe")
        .locator('[contenteditable="true"]')
        .waitFor({ state: "visible", timeout: 3000 });

      const result = await __private.detectMessagingContext(page, 3000);
      assert.equal(result.mode, "iframe");
      assert.ok(result.frame);
      assert.match(result.reason, /compose URL/);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 7: the iframe composer can have both Subject and body fields ──────
//
// This mirrors the saved LinkedIn DM checkpoint: the active /preload/ frame
// exposes two text fields. The automation must type only into the message body.

test(
  "iframe DM typing selects the message body instead of Subject",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    try {
      await serveHtml(
        context,
        "**/preload/**",
        `<html><body>
          <section class="msg-overlay-conversation-bubble" role="dialog"
                   style="display:block;width:540px;height:420px;">
            <input aria-label="Subject" placeholder="Subject" role="textbox"
                   style="display:block;width:480px;height:32px;" />
            <form class="msg-form">
              <div class="msg-form__contenteditable" contenteditable="true"
                   role="textbox" aria-label="Write a message"
                   style="display:block;width:480px;height:180px;"></div>
              <button type="submit" aria-label="Send">Send</button>
            </form>
          </section>
        </body></html>`,
      );
      await serveHtml(
        context,
        "**/in/some-profile",
        `<html><body><iframe data-testid="interop-iframe"
          src="/preload/?_bprMode=vanilla" style="width:100vw;height:100vh;"></iframe></body></html>`,
      );
      await page.goto("https://www.linkedin.com/in/some-profile");

      const contextResult = await __private.detectMessagingContext(page, 3000);
      assert.equal(contextResult.mode, "iframe");
      const editor = await __private.findBestDmEditor(contextResult.frame, 1000);
      assert.ok(editor, "expected the iframe message editor");

      process.env.TEST_SPEEDUP = "true";
      const body = "Hi Allan, thanks for connecting.";
      assert.equal(
        await __private.typeLikeHuman(page, editor.locator, body),
        true,
      );
      assert.equal(await editor.locator.textContent(), body);
      assert.equal(
        await contextResult.frame.locator('[aria-label="Subject"]').inputValue(),
        "",
        "subject must remain empty",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

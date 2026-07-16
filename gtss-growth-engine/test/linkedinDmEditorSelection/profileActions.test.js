/**
 * Profile action & messaging-blocked tests.
 *
 * Verifies:
 *  - findProfileMessageAction locates the visible primary profile Message CTA
 *  - detectMessagingBlocked classifies LinkedIn premium messaging blocks
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private } = require("./_helpers");

// ─── test 8: visible primary Message action is accepted ──────────────────────

test(
  "findProfileMessageAction locates the visible primary profile Message CTA",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main>
          <section class="pv-top-card" style="position:relative;margin-top:90px;width:700px;height:260px;">
            <h1 class="text-heading-xlarge">Lilian Otieno</h1>
            <button style="width:120px;height:40px;">Message</button>
          </section>
        </main>
      `);

      const message = await __private.findProfileMessageAction(page, 1200);
      assert.ok(message, "visible primary profile Message action should be found");
      assert.match(message.selector, /compose:Message/);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 9: blocked messaging dialog is classified quickly ──────────────────

test(
  "detectMessagingBlocked classifies LinkedIn premium messaging blocks",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main></main>
        <div role="dialog" style="display:block;width:420px;height:240px;">
          <h2>With Premium, you can message anyone</h2>
          <button>Get Premium</button>
        </div>
      `);

      const blocked = await __private.detectMessagingBlocked(page, 300);
      assert.ok(blocked, "premium dialog should be detected");
      assert.equal(blocked.outcome, "premium_required");
    } finally {
      await browser.close();
    }
  },
);

// ─── test 9b: "Build your dream team" premium wall ───────────────────────────

test(
  "detectPremiumRequired classifies Build your dream team premium wall",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main></main>
        <div role="dialog" style="display:block;width:480px;height:320px;">
          <h2>Build your dream team</h2>
          <p>With Premium, you can message anyone and grow faster.</p>
          <button>Try Premium for free</button>
          <button aria-label="Dismiss">×</button>
        </div>
      `);

      const blocked = await __private.detectPremiumRequired(page, {
        dismissIfFound: true,
      });
      assert.ok(blocked, "dream-team premium dialog should be detected");
      assert.equal(blocked.outcome, "premium_required");
    } finally {
      await browser.close();
    }
  },
);

// ─── test 9c: For Business flyout is NOT treated as premium ──────────────────

test(
  "detectPremiumRequired ignores For Business explore panel",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main><h1>Someone</h1></main>
        <button aria-label="For Business" aria-expanded="true">For Business</button>
        <div role="dialog" style="display:block;width:420px;height:400px;">
          <h2>Explore more for business</h2>
          <p>My Apps</p>
          <p>Hire on LinkedIn</p>
          <p>Sell with LinkedIn</p>
          <input role="textbox" aria-label="Search" />
        </div>
      `);

      const blocked = await __private.detectPremiumRequired(page, {
        dismissIfFound: false,
      });
      assert.equal(
        blocked,
        null,
        "For Business panel must not be classified as premium_required",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── test 9d: "Status is reachable" is not a recipient name ──────────────────

test(
  "verifyModalRecipient ignores Status is reachable chrome text",
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
          style="display:block;width:480px;height:420px;position:fixed;left:40px;top:80px;">
          <header class="msg-overlay-bubble-header">
            <span class="msg-overlay-bubble-header__name">Status is reachable</span>
            <a href="/in/angela-onsarigo/">Angela onsarigo</a>
          </header>
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true"
              role="textbox" aria-label="Write a message…"
              style="display:block;width:400px;height:160px;"></div>
          </form>
        </section>
      `);

      const editor = page.locator('.msg-form__contenteditable').first();
      const result = await __private.verifyModalRecipient(
        page,
        editor,
        "Dennis Mokaya & Angela onsarigo are mutual connections",
      );
      assert.equal(result.ok, true, "must not hard-fail on status chrome");
      // Either matched Angela via /in/ link, or ignored status and warned.
      if (result.actual) {
        assert.match(String(result.actual), /angela/i);
      }
    } finally {
      await browser.close();
    }
  },
);

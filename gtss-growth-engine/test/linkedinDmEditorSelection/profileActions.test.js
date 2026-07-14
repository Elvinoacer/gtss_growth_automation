/**
 * Profile action & messaging-blocked tests.
 *
 * Verifies:
 *  - findProfileMessageAction locates Message from the profile More menu
 *  - detectMessagingBlocked classifies LinkedIn premium messaging blocks
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private } = require("./_helpers");

// ─── test 8: profile Message action can be hidden in More menu ───────────────

test(
  "findProfileMessageAction locates Message from the profile More menu",
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
            <button aria-label="More actions" style="width:120px;height:40px;">More</button>
          </section>
        </main>
        <div class="artdeco-dropdown__content" role="menu" style="display:block;position:absolute;top:170px;left:20px;width:220px;height:160px;">
          <button aria-label="Message Lilian Otieno" style="width:180px;height:36px;">Message</button>
        </div>
      `);

      const message = await __private.findProfileMessageAction(page, 1200);
      assert.ok(message, "message action should be found inside More menu");
      assert.match(message.selector, /More menu/);
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

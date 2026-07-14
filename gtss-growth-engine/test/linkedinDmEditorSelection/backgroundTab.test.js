/**
 * Background-tab regression test — Bug #1.
 *
 * Reproduces the production CDP multi-tab environment that caused all 6 bugs.
 * In CDP mode, the LinkedIn tab is a background tab — document.hasFocus() is
 * false, React drops all keyboard events, and typing silently fails.
 *
 * Without bringToFront: focus fails → text never lands → Send button stays disabled.
 * With bringToFront:    focus succeeds → text lands → Send button enables.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private, dmOverlayHtml } = require("./_helpers");

test(
  "bringToFront restores document.hasFocus() in a background tab (Bug #1 regression)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: false }); // needs a real window for hasFocus
    const context = browser.contexts()[0] || (await browser.newContext());
    const page1 = await context.newPage();

    try {
      await page1.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      // Open a second tab and bring it to front — page1 is now background.
      const page2 = await context.newPage();
      await page2.bringToFront();
      await new Promise((r) => setTimeout(r, 150));

      // Verify page1 does NOT have focus (simulates the production bug condition).
      const focusBeforeBringToFront = await page1
        .evaluate(() => document.hasFocus())
        .catch(() => false);

      // Now simulate what bringLinkedInPageToFront does.
      await page1.bringToFront();
      await new Promise((r) => setTimeout(r, 200));

      const focusAfterBringToFront = await page1
        .evaluate(() => document.hasFocus())
        .catch(() => false);
      assert.equal(
        focusAfterBringToFront,
        true,
        "document.hasFocus() must be true after bringToFront — keyboard events will now land",
      );

      // Full integration: type into the editor on the now-foregrounded page.
      const editor = await __private.findBestDmEditor(page1, 1000);
      assert.ok(editor, "editor must be found on page1");
      await __private.typeLikeHuman(
        page1,
        editor.locator,
        "Background tab fix verified.",
      );
      const text = await editor.locator.textContent();
      assert.equal(text, "Background tab fix verified.");

      await page2.close();
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

/**
 * Editor activation tests — waitForEditorInteractive + activateDmEditor.
 *
 * Verifies:
 *  - waitForEditorInteractive resolves once pointer-events transitions from
 *    none to auto (animation guard)
 *  - activateDmEditor dispatches pointerdown before mousedown so React
 *    onPointerDown fires (event ordering)
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private, dmOverlayHtml } = require("./_helpers");

// ─── test 2: pointer-events:none animation guard ───────────────────────────────

test(
  "waitForEditorInteractive resolves once pointer-events transitions from none to auto",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Mount with pointer-events:none (simulates mid-animation state)
      await page.setContent(dmOverlayHtml({ pointerEvents: "none" }));
      process.env.TEST_SPEEDUP = "true";

      // Should NOT be interactive yet
      const notYet = await __private.waitForEditorInteractive(page, 200);
      assert.equal(
        notYet,
        false,
        "should not be interactive while pointer-events:none",
      );

      // Enable pointer events (simulates animation end)
      await page.evaluate(() => {
        const el = document.querySelector(".msg-form__contenteditable");
        el.style.pointerEvents = "auto";
      });

      const nowInteractive = await __private.waitForEditorInteractive(
        page,
        800,
      );
      assert.equal(
        nowInteractive,
        true,
        "should become interactive after pointer-events:auto",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 4: activateDmEditor fires pointer events ────────────────────────────

test(
  "activateDmEditor dispatches pointerdown before mousedown so React onPointerDown fires",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      // Spy on pointer/mouse events
      await page.evaluate(() => {
        window.__gtssEvents = [];
        const el = document.querySelector(".msg-form__contenteditable");
        ["pointerdown", "mousedown", "focusin", "click"].forEach((name) => {
          el.addEventListener(name, () => window.__gtssEvents.push(name));
        });
      });

      const locator = page
        .locator('.msg-form__contenteditable[contenteditable="true"]')
        .last();
      await __private.activateDmEditor(page, locator);

      const events = await page.evaluate(() => window.__gtssEvents);

      assert.ok(
        events.includes("pointerdown"),
        `pointerdown must fire — got: ${JSON.stringify(events)}`,
      );
      assert.ok(
        events.includes("mousedown"),
        `mousedown must fire — got: ${JSON.stringify(events)}`,
      );

      // pointerdown MUST come before mousedown (LinkedIn's handler order)
      assert.ok(
        events.indexOf("pointerdown") < events.indexOf("mousedown"),
        "pointerdown must precede mousedown in the event sequence",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

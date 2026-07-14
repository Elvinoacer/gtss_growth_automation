/**
 * Modal recipient verification tests — verifyModalRecipient.
 *
 * Verifies:
 *  - verifyModalRecipient blocks send when the modal's recipient name does not
 *    match the expected lead (with both mismatch and match cases)
 *  - verifyModalRecipient returns ok=true (with warning) when the modal has no
 *    extractable recipient name (defensive — modal-aware editor selection
 *    already ensures correct modal)
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private } = require("./_helpers");

// ─── test 19: verifyModalRecipient blocks on name mismatch ────────────────────

test(
  "verifyModalRecipient blocks send when the modal's recipient name does not match the expected lead",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main></main>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-modal="true"
          style="position:fixed;left:200px;top:120px;width:560px;height:540px;display:block;visibility:visible;opacity:1;"
        >
          <header class="msg-overlay-bubble-header">
            <a href="/in/wrongperson/" class="msg-overlay-bubble-header__name">Letrise Johnson</a>
            <button aria-label="Close">x</button>
          </header>
          <form class="msg-form">
            <div
              id="the-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:520px;height:240px;"
            ></div>
          </form>
        </section>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator("#the-editor");

      // Mismatch case: modal says "Letrise", expected lead is "Mike".
      const result = await __private.verifyModalRecipient(page, editor, "Mike Peterson");
      assert.equal(result.ok, false, "must report ok=false when modal recipient does not match expected lead");
      assert.ok(result.reason, "must provide a reason");
      assert.match(result.actual, /letrise/i);
      assert.match(result.expected, /mike/i);

      // Match case: modal says "Letrise", expected lead is "Letrise".
      const okResult = await __private.verifyModalRecipient(page, editor, "Letrise Johnson");
      assert.equal(okResult.ok, true, "must report ok=true when modal recipient matches expected lead");
      assert.match(okResult.actual, /letrise/i);

      // No expected name → always ok (defensive).
      const nullResult = await __private.verifyModalRecipient(page, editor, null);
      assert.equal(nullResult.ok, true, "must report ok=true when no expected name is provided");
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 20: no extractable recipient name → ok=true with warning ───────────

test(
  "verifyModalRecipient returns ok=true (with warning) when the modal has no extractable recipient name",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Modal with NO recognizable recipient-name header element. The
      // helper must NOT fail — the modal-aware editor selection already
      // ensures we're in the correct modal. It should return ok=true with
      // a warning so the operator knows the verification was inconclusive.
      await page.setContent(`
        <main></main>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-modal="true"
          style="position:fixed;left:200px;top:120px;width:560px;height:540px;display:block;visibility:visible;opacity:1;"
        >
          <h2>New message</h2>
          <input aria-label="Subject" placeholder="Subject" style="display:block;width:520px;height:32px;" />
          <form class="msg-form">
            <div
              id="the-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:520px;height:240px;"
            ></div>
          </form>
        </section>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator("#the-editor");
      const result = await __private.verifyModalRecipient(page, editor, "Mike Peterson");
      assert.equal(result.ok, true, "must NOT block send when recipient name cannot be extracted (modal-aware editor selection already ensures correct modal)");
      assert.ok(result.warning, "must include a warning explaining the verification was inconclusive");
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

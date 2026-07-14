/**
 * Editor selection tests — findBestDmEditor modal/overlay disambiguation.
 *
 * Verifies findBestDmEditor:
 *  - prefers the message body over the Subject field (baseline)
 *  - picks the .msg-form__contenteditable editor over a generic contenteditable
 *  - picks the alternate compose modal's editor over a background conversation
 *    bubble (wrong-recipient regression)
 *  - never picks an editor from a minimized conversation bubble
 *  - fails safe (returns null) when two equally-prominent chat bubbles are
 *    present and no compose modal is available
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const {
  SKIP,
  __private,
  dmOverlayHtml,
  alternateModalAndBackgroundBubbleHtml,
} = require("./_helpers");

// ─── test 1: baseline selector preference ─────────────────────────────────────

test(
  "LinkedIn DM editor selection prefers message body over subject field",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "expected a message editor to be found");

      const ariaLabel = await editor.locator.getAttribute("aria-label");
      assert.match(ariaLabel, /write a message/i);

      await __private.typeLikeHuman(
        page,
        editor.locator,
        "Hello Allan, thanks for connecting.",
      );
      const editorText = await editor.locator.textContent();
      assert.equal(editorText, "Hello Allan, thanks for connecting.");

      const subjectValue = await page
        .locator('[aria-label="Subject"]')
        .inputValue();
      assert.equal(
        subjectValue,
        "",
        "subject field must not receive the DM body",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 5: multiple editors — highest-scoring wins ──────────────────────────

test(
  "findBestDmEditor picks msg-form__contenteditable over a generic contenteditable",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Inject a second bare contenteditable (lower score) alongside the real editor
      await page.setContent(
        dmOverlayHtml({
          extraEditors: `
          <div
            contenteditable="true"
            aria-label="some other editable"
            style="display:block;width:200px;height:40px;"
          ></div>`,
        }),
      );
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "editor must be found");

      const ariaLabel = await editor.locator.getAttribute("aria-label");
      assert.match(
        ariaLabel,
        /write a message/i,
        "should pick the msg-form editor, not the generic one",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 15: alternate compose modal beats background bubble (wrong-recipient regression) ──

test(
  "findBestDmEditor picks the alternate compose modal's editor over a background conversation bubble (wrong-recipient regression)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(alternateModalAndBackgroundBubbleHtml());
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1500);
      assert.ok(editor, "an editor must be found");

      const editorId = await editor.locator.getAttribute("id");
      assert.equal(
        editorId,
        "active-modal-editor",
        "must pick the active compose modal's editor, NOT the background conversation bubble's editor",
      );

      // Sanity: the chosen editor must be inside the modal that has the
      // Subject input (i.e. the alternate compose modal).
      const hasSubjectSibling = await editor.locator.evaluate((el) => {
        const overlay = el.closest('.msg-overlay-conversation-bubble, [role="dialog"]');
        if (!overlay) return false;
        return Boolean(
          overlay.querySelector(
            'input[aria-label*="subject" i], input[placeholder*="subject" i]',
          ),
        );
      });
      assert.equal(
        hasSubjectSibling,
        true,
        "chosen editor must live inside the modal that has the Subject input",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 16: minimized bubble never picked ───────────────────────────────────

test(
  "findBestDmEditor never picks an editor from a minimized conversation bubble",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Two bubbles: the first is minimized (aria-expanded="false", small
      // height), the second is the active compose modal. The minimized
      // bubble's editor technically exists in the DOM but must NEVER be
      // picked.
      await page.setContent(`
        <main></main>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-expanded="false"
          style="position:fixed;left:72px;top:600px;width:502px;height:80px;display:block;visibility:visible;opacity:1;"
        >
          <header class="msg-overlay-bubble-header">
            <a href="/in/minimized-recipient/">Minimized Recipient</a>
            <button aria-label="Close">x</button>
          </header>
          <form class="msg-form" style="display:none;">
            <div
              id="minimized-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:440px;height:160px;"
            ></div>
          </form>
        </section>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-expanded="true"
          style="position:fixed;left:200px;top:120px;width:560px;height:540px;display:block;visibility:visible;opacity:1;z-index:100;"
        >
          <h2>New message</h2>
          <input aria-label="Subject" placeholder="Subject" style="display:block;width:520px;height:32px;" />
          <form class="msg-form">
            <div
              id="active-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:520px;height:240px;"
            ></div>
            <button class="msg-form__send-button" type="submit">Send</button>
          </form>
        </section>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1500);
      assert.ok(editor, "an editor must be found");

      const editorId = await editor.locator.getAttribute("id");
      assert.equal(
        editorId,
        "active-editor",
        "must pick the active modal's editor, never the minimized bubble's editor",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 17: ambiguous bubbles → fail safe ───────────────────────────────────

test(
  "findBestDmEditor fails safe (returns null) when two equally-prominent chat bubbles are present and no compose modal",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Two identical open chat bubbles — no compose modal, no aria-modal,
      // no subject input, same z-index, same size. Scoring cannot confidently
      // identify the active one. The new code MUST fail safe.
      await page.setContent(`
        <main></main>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-expanded="true"
          style="position:fixed;left:72px;top:300px;width:502px;height:340px;display:block;visibility:visible;opacity:1;z-index:10;"
        >
          <header class="msg-overlay-bubble-header">
            <a href="/in/first-recipient/">First Recipient</a>
          </header>
          <form class="msg-form">
            <div
              id="first-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:440px;height:160px;"
            ></div>
            <button class="msg-form__send-button" type="submit">Send</button>
          </form>
        </section>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-expanded="true"
          style="position:fixed;left:72px;top:300px;width:502px;height:340px;display:block;visibility:visible;opacity:1;z-index:10;"
        >
          <header class="msg-overlay-bubble-header">
            <a href="/in/second-recipient/">Second Recipient</a>
          </header>
          <form class="msg-form">
            <div
              id="second-editor"
              class="msg-form__contenteditable"
              contenteditable="true"
              aria-label="Write a message"
              style="display:block;width:440px;height:160px;"
            ></div>
            <button class="msg-form__send-button" type="submit">Send</button>
          </form>
        </section>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1200);
      assert.equal(
        editor,
        null,
        "findBestDmEditor MUST return null when two equally-prominent chat bubbles are present — never guess",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

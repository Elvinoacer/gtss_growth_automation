/**
 * Send button tests — findSendButtonForEditor + clickSendButtonRobust.
 *
 * Verifies:
 *  - findSendButtonForEditor tracks aria-disabled send buttons inside the composer
 *  - findSendButtonForEditor scopes Send lookup to the active composer (not stale)
 *  - clickSendButtonRobust clicks icon-only LinkedIn Send controls
 *  - findSendButtonForEditor returns null when the editor's container has no
 *    send button — no page-root fallback (wrong-recipient regression)
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private } = require("./_helpers");

// ─── test 10a: send button disabled state ────────────────────────────────────

test(
  "findSendButtonForEditor tracks aria-disabled send buttons inside the composer",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <section class="msg-overlay-conversation-bubble" role="dialog" style="display:block;width:500px;height:420px;">
          <form class="msg-form" style="display:block;height:360px;">
            <div
              class="msg-form__contenteditable"
              contenteditable="true"
              role="textbox"
              aria-label="Write a message"
              style="display:block;width:440px;height:200px;"
            ></div>
            <button aria-label="Attach" type="button">Attach</button>
            <button
              class="msg-form__send-button artdeco-button--disabled"
              aria-label="Send"
              aria-disabled="true"
              type="submit"
            >Send</button>
          </form>
        </section>
      `);

      const editor = page.locator(".msg-form__contenteditable");
      const disabledSend = await __private.findSendButtonForEditor(
        page,
        editor,
      );
      assert.ok(disabledSend, "send button should be found while disabled");
      assert.equal(disabledSend.disabled, true);

      await page.evaluate(() => {
        const send = document.querySelector(".msg-form__send-button");
        send.setAttribute("aria-disabled", "false");
        send.classList.remove("artdeco-button--disabled");
      });

      const enabledSend = await __private.findSendButtonForEditor(page, editor);
      assert.ok(
        enabledSend,
        "send button should still be found after enabling",
      );
      assert.equal(enabledSend.disabled, false);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 10b: scope to active composer ──────────────────────────────────────

test(
  "findSendButtonForEditor scopes Send lookup to the active composer",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <section class="msg-overlay-conversation-bubble" role="dialog" style="display:block;width:500px;height:260px;">
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true" aria-label="Old message" style="display:block;width:440px;height:80px;"></div>
            <button class="msg-form__send-button artdeco-button--disabled" aria-label="Send" aria-disabled="true" type="submit">Send</button>
          </form>
        </section>
        <section class="msg-overlay-conversation-bubble" role="dialog" style="display:block;width:500px;height:260px;">
          <form class="msg-form">
            <div id="active-editor" class="msg-form__contenteditable" contenteditable="true" aria-label="Write a message" style="display:block;width:440px;height:80px;"></div>
            <button id="active-send" class="msg-form__send-button" aria-label="Send message" aria-disabled="false" type="submit">Send</button>
          </form>
        </section>
      `);

      const editor = page.locator("#active-editor");
      const send = await __private.findSendButtonForEditor(page, editor);

      assert.ok(send, "active composer send button should be found");
      assert.equal(send.disabled, false);
      assert.equal(
        await send.locator.getAttribute("id"),
        "active-send",
        "must not return stale disabled send button from another composer",
      );
    } finally {
      await browser.close();
    }
  },
);

// ─── test 10c: clickSendButtonRobust clicks icon-only Send ────────────────────

test(
  "clickSendButtonRobust clicks icon-only LinkedIn Send controls",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <section class="msg-overlay-conversation-bubble" role="dialog" style="display:block;width:500px;height:260px;">
          <form class="msg-form" onsubmit="event.preventDefault(); window.__gtssSubmitted = true;">
            <div id="active-editor" class="msg-form__contenteditable" contenteditable="true" aria-label="Write a message" style="display:block;width:440px;height:80px;">Hello</div>
            <button id="icon-send" aria-label="Send" type="submit" style="display:block;width:40px;height:32px;">
              <svg aria-hidden="true"></svg>
            </button>
          </form>
        </section>
        <script>
          window.__gtssClicked = false;
          document.querySelector("#icon-send").addEventListener("click", () => {
            window.__gtssClicked = true;
          });
        </script>
      `);

      const editor = page.locator("#active-editor");
      const send = await __private.findSendButtonForEditor(page, editor);
      assert.ok(send, "icon-only send button should be found by aria-label");
      assert.equal(await send.locator.getAttribute("id"), "icon-send");

      const clicked = await __private.clickSendButtonRobust(
        page,
        send.locator,
        editor,
      );

      assert.equal(clicked, true);
      assert.equal(await page.evaluate(() => window.__gtssClicked), true);
      assert.equal(await page.evaluate(() => window.__gtssSubmitted), true);
    } finally {
      await browser.close();
    }
  },
);

// ─── test 18: no page-root fallback (wrong-recipient regression) ──────────────

test(
  "findSendButtonForEditor returns null when the editor's container has no send button — no page-root fallback (wrong-recipient regression)",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Two modals. The "wrong" modal has a Send button. The active modal's
      // container has NO send button (simulating a UI where the send button
      // is elsewhere). The OLD code would fall back to page-root query and
      // return the WRONG modal's send button — clicking it would send our
      // message to the wrong recipient. The new code MUST return null.
      await page.setContent(`
        <main></main>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-expanded="true"
          style="position:fixed;left:72px;top:400px;width:502px;height:340px;display:block;visibility:visible;opacity:1;z-index:10;"
        >
          <header class="msg-overlay-bubble-header">
            <a href="/in/wrong-recipient/">Wrong Recipient</a>
          </header>
          <form class="msg-form">
            <div class="msg-form__contenteditable" contenteditable="true" aria-label="Write a message" style="display:block;width:440px;height:160px;"></div>
            <button id="wrong-send" class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
          </form>
        </section>
        <section
          class="msg-overlay-conversation-bubble"
          role="dialog"
          aria-modal="true"
          aria-expanded="true"
          style="position:fixed;left:200px;top:120px;width:560px;height:540px;display:block;visibility:visible;opacity:1;z-index:1000;"
        >
          <h2>New message</h2>
          <input aria-label="Subject" placeholder="Subject" style="display:block;width:520px;height:32px;" />
          <form class="msg-form">
            <div id="active-editor-no-send" class="msg-form__contenteditable" contenteditable="true" aria-label="Write a message" style="display:block;width:520px;height:240px;"></div>
            <!-- NOTE: NO send button inside this form. -->
          </form>
        </section>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator("#active-editor-no-send");
      const send = await __private.findSendButtonForEditor(page, editor);

      assert.equal(
        send,
        null,
        "must NOT fall back to page-root query — doing so could return the wrong modal's send button",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

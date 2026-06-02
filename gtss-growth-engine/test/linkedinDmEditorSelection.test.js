const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { chromium } = require("playwright");

const { __private } = require("../src/automation/linkedin");

const browserPath = chromium.executablePath();
const browserMissing = !fs.existsSync(browserPath);

test(
  "LinkedIn DM editor selection prefers message body over subject field",
  { skip: browserMissing ? `Playwright browser binary is not installed at ${browserPath}` : false },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

    try {
      await page.setContent(`
        <main></main>
        <section class="msg-overlay-conversation-bubble" role="dialog" style="position: fixed; left: 72px; top: 186px; width: 502px; height: 520px; display: block; visibility: visible; opacity: 1;">
          <h2>New message</h2>
          <input aria-label="Subject" placeholder="Subject" role="textbox" style="display:block; width: 440px; height: 32px;" />
          <form class="msg-form" style="display:block; margin-top: 16px;">
            <div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…" data-placeholder="Write a message..." style="display:block; width: 440px; height: 200px; border: 1px solid #ddd;"></div>
            <button class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
          </form>
        </section>
      `);

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "expected a message editor to be found");

      const ariaLabel = await editor.locator.getAttribute("aria-label");
      assert.match(ariaLabel, /write a message/i);

      await __private.typeLikeHuman(page, editor.locator, "Hello Allan, thanks for connecting.");
      const editorText = await editor.locator.textContent();
      assert.equal(editorText, "Hello Allan, thanks for connecting.");

      const subjectValue = await page.locator('[aria-label="Subject"]').inputValue();
      assert.equal(subjectValue, "", "subject field must not receive the DM body");
    } finally {
      await browser.close();
    }
  },
);

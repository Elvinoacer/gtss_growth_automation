/**
 * Modal recipient verification tests — verifyModalRecipient.
 *
 * Verifies:
 *  - verifyModalRecipient blocks send when the modal's recipient name does not
 *    match the expected lead (with both mismatch and match cases)
 *  - verifyModalRecipient fails closed when the modal has no extractable
 *    recipient name; an editor scope is not proof of who will receive a DM.
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

// ─── test 20: no extractable recipient name → fail closed ────────────────────

test(
  "verifyModalRecipient blocks send when the modal has no extractable recipient name",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Modal with NO recognizable recipient-name header element. The
      // A modal-scoped editor is not proof that this is Mike's composer.
      // Recipient identity must be positively established before any DM send.
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
      assert.equal(result.ok, false, "must block send when recipient name cannot be extracted");
      assert.match(result.reason, /cannot extract a recipient/i);
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 21: existing thread must use profile card, not message sender ───────
//
// Production bug (AKONKWA LWAMBWA): on people already messaged, the thread
// contains `.msg-s-message-group__name` = the logged-in user ("elvin Juma").
// Older verification scraped that as the modal recipient and blocked the send.
// The real recipient lives on `.msg-s-profile-card`.

test(
  "verifyModalRecipient prefers profile-card recipient over message-group sender on existing threads",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main class="scaffold-layout">
          <div class="scaffold-layout__list"><!-- inbox list --></div>
          <div class="scaffold-layout__detail" style="display:block;width:640px;height:700px;position:relative;">
            <aside class="msg-s-profile-card" style="display:block;padding:12px;">
              <a class="profile-card-one-to-one__profile-link" href="/in/akonkwa-lwambwa-65188b34a/">
                <div class="artdeco-entity-lockup__title">
                  <span class="truncate">AKONKWA LWAMBWA</span>
                </div>
              </a>
              <div class="artdeco-entity-lockup__subtitle">
                <div>Software Engineer | AI Enthusiast</div>
              </div>
            </aside>
            <div class="msg-s-message-list-content">
              <div class="msg-s-event-listitem" data-view-name="message-list-item">
                <div class="msg-s-message-group__name">elvin Juma</div>
                <div class="msg-s-message-group__timestamp">8:22 PM</div>
                <div class="msg-s-event-listitem__body">
                  Hi AKONKWA, I'm reaching out because...
                </div>
              </div>
            </div>
            <form class="msg-form">
              <div
                id="the-editor"
                class="msg-form__contenteditable"
                contenteditable="true"
                role="textbox"
                aria-label="Write a message…"
                style="display:block;width:600px;height:120px;"
              ></div>
              <button type="submit" class="msg-form__send-button">Send</button>
            </form>
          </div>
        </main>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator("#the-editor");
      const result = await __private.verifyModalRecipient(
        page,
        editor,
        "AKONKWA LWAMBWA",
      );
      assert.equal(
        result.ok,
        true,
        `must accept profile-card recipient (got: ${JSON.stringify(result)})`,
      );
      assert.match(String(result.actual), /akonkwa/i);
      assert.doesNotMatch(
        String(result.actual || ""),
        /elvin/i,
        "must not report the message-group sender as the recipient",
      );

      // Mismatch still blocks when the card is a different person.
      const mismatch = await __private.verifyModalRecipient(
        page,
        editor,
        "Mike Peterson",
      );
      assert.equal(mismatch.ok, false);
      assert.match(String(mismatch.actual), /akonkwa/i);
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 22: full-page compose recipient chip ────────────────────────────────

test(
  "verifyModalRecipient reads the compose recipient chip on full-page /messaging/compose",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(`
        <main class="scaffold-layout">
          <div class="scaffold-layout__detail" style="display:block;width:640px;height:700px;">
            <h2>New message</h2>
            <div class="msg-form__recipients">
              <ul>
                <li class="msg-connections-typeahead__recipient-token">
                  <span class="artdeco-pill artdeco-pill--choice">
                    <span class="artdeco-pill__text">AKONKWA LWAMBWA</span>
                  </span>
                  <button aria-label="Remove">×</button>
                </li>
              </ul>
            </div>
            <!-- Prior outgoing message body can appear above the composer -->
            <div class="msg-s-message-list-content">
              <div class="msg-s-event-listitem">
                <div class="msg-s-message-group__name">elvin Juma</div>
                <div class="msg-s-event-listitem__body">Best, Elvin</div>
              </div>
            </div>
            <form class="msg-form">
              <div
                id="the-editor"
                class="msg-form__contenteditable"
                contenteditable="true"
                role="textbox"
                aria-label="Write a message…"
                style="display:block;width:600px;height:120px;"
              ></div>
            </form>
          </div>
        </main>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator("#the-editor");
      const result = await __private.verifyModalRecipient(
        page,
        editor,
        "AKONKWA LWAMBWA",
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.match(String(result.actual), /akonkwa/i);
      assert.doesNotMatch(String(result.actual || ""), /elvin/i);
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 23: compose-URL URN overrides a sender-name false positive ──────────

test(
  "verifyModalRecipient trusts matching compose URL when a stale sender name is scraped",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    const urn = "urn:li:fsd_profile:ACoAAFdW1d0BbzuEI2coKxvCTjnTsd-BHs3TN5s";
    const composeUrl =
      `https://www.linkedin.com/messaging/compose/?profileUrn=${encodeURIComponent(urn)}` +
      `&recipient=ACoAAFdW1d0BbzuEI2coKxvCTjnTsd-BHs3TN5s&interop=msgOverlay`;

    try {
      // No high-confidence card/chip — only a message-list sender name that
      // older code would treat as the recipient. The compose URL is the proof.
      await page.goto(
        "data:text/html," +
          encodeURIComponent(`
        <main>
          <div class="scaffold-layout__detail" style="display:block;width:600px;height:500px;">
            <div class="msg-s-message-list-content">
              <div class="msg-s-event-listitem">
                <a href="/in/elvin-juma/">elvin Juma</a>
                <div class="msg-s-message-group__name">elvin Juma</div>
              </div>
            </div>
            <form class="msg-form">
              <div id="the-editor" class="msg-form__contenteditable"
                contenteditable="true" role="textbox" aria-label="Write a message…"
                style="display:block;width:500px;height:100px;"></div>
            </form>
          </div>
        </main>
      `),
      );
      // Spoof the page URL to the messaging compose route (data: can't do this).
      await page.evaluate((url) => {
        // Replace history so page.url() reflects the compose route.
        window.history.replaceState({}, "", url);
      }, composeUrl);

      // Playwright's page.url() reads the real navigation URL; replaceState on
      // a data: document may not change it. Force via a lightweight route mock.
      // If replaceState did not stick, navigate through a stub.
      if (!/messaging\/compose/.test(page.url())) {
        await page.route("**/messaging/compose/**", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `
              <main>
                <div class="scaffold-layout__detail" style="display:block;width:600px;height:500px;">
                  <div class="msg-s-message-list-content">
                    <div class="msg-s-event-listitem">
                      <a href="/in/elvin-juma/" style="position:relative;top:0;">elvin Juma</a>
                      <div class="msg-s-message-group__name">elvin Juma</div>
                    </div>
                  </div>
                  <form class="msg-form">
                    <div id="the-editor" class="msg-form__contenteditable"
                      contenteditable="true" role="textbox" aria-label="Write a message…"
                      style="display:block;width:500px;height:100px;"></div>
                  </form>
                </div>
              </main>
            `,
          });
        });
        await page.goto(composeUrl, { waitUntil: "domcontentloaded" });
      }

      process.env.TEST_SPEEDUP = "true";
      const editor = page.locator("#the-editor");
      const result = await __private.verifyModalRecipient(
        page,
        editor,
        "AKONKWA LWAMBWA",
        { composeUrl },
      );
      assert.equal(
        result.ok,
        true,
        `compose URL must override sender-name scrape (got: ${JSON.stringify(result)})`,
      );
      assert.match(String(result.actual || ""), /compose recipient|ACoAAFdW1d0/i);
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

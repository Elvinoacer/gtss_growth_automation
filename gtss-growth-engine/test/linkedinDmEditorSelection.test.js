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

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal LinkedIn-style DM overlay HTML. */
function dmOverlayHtml({ pointerEvents = "auto", extraEditors = "" } = {}) {
  return `
    <main></main>
    <section
      class="msg-overlay-conversation-bubble"
      role="dialog"
      style="position:fixed;left:72px;top:186px;width:502px;height:520px;display:block;visibility:visible;opacity:1;"
    >
      <h2>New message</h2>
      <input
        aria-label="Subject"
        placeholder="Subject"
        role="textbox"
        style="display:block;width:440px;height:32px;"
      />
      <form class="msg-form" style="display:block;margin-top:16px;">
        <div
          class="msg-form__contenteditable"
          contenteditable="true"
          role="textbox"
          aria-label="Write a message…"
          data-placeholder="Write a message..."
          style="display:block;width:440px;height:200px;border:1px solid #ddd;pointer-events:${pointerEvents};"
        ></div>
        <button class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
      </form>
      ${extraEditors}
    </section>
  `;
}

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

// ─── test 1b: multi-line message verification ───────────────────────────────

test(
  "typeLikeHuman accepts LinkedIn's flattened textContent for multi-line DMs",
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

      await __private.typeLikeHuman(
        page,
        editor.locator,
        "Hi Allan,\n\nThanks for connecting.\n\nBest,\nElvin",
      );

      assert.match(
        await editor.locator.textContent(),
        /Hi Allan,\s*Thanks for connecting\.\s*Best,\s*Elvin/,
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

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

// ─── test 3: React re-render — stale token locator recovery ───────────────────

test(
  "typeLikeHuman can type after the editor node is replaced by a React re-render",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      // 1. Find the editor and stamp the data-gtss token on it (as the real code does).
      const editorMatch = await __private.findBestDmEditor(page, 1000);
      assert.ok(editorMatch, "editor must be found before re-render");

      // 2. Simulate a React re-render: remove the old node and insert a fresh one.
      //    The data-gtss-dm-editor token is gone from the DOM at this point, which
      //    means editorMatch.locator now resolves to ZERO elements.
      await page.evaluate(() => {
        const old = document.querySelector(".msg-form__contenteditable");
        const fresh = old.cloneNode(false); // clone without the data-gtss-* attribute
        for (const attr of [...fresh.attributes]) {
          if (attr.name.startsWith("data-gtss-")) {
            fresh.removeAttribute(attr.name);
          }
        }
        fresh.textContent = "";
        old.replaceWith(fresh);
      });

      // 3. The token-based locator should match nothing after the re-render.
      const tokenMatchCount = await editorMatch.locator.count().catch(() => 0);
      assert.equal(
        tokenMatchCount,
        0,
        "token locator should be stale after re-render",
      );

      // 4. typeLikeHuman must recover by re-discovering the fresh stable editor.
      //    It should NOT throw and the text must land in the new node.
      const stableLocator = page
        .locator('.msg-form__contenteditable[contenteditable="true"]')
        .last();
      await __private.typeLikeHuman(
        page,
        stableLocator,
        "Re-render recovery test.",
      );

      const freshText = await page
        .locator(".msg-form__contenteditable")
        .last()
        .textContent();
      assert.equal(freshText, "Re-render recovery test.");
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

// ─── test 6: focus verification catches wrong-element focus ───────────────────

test(
  "typeLikeHuman can still type when pointer events block regular clicks",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Page with NO msg-form__contenteditable — focus can never land correctly
      await page.setContent(`
        <main></main>
        <div
          id="broken-editor"
          contenteditable="true"
          aria-label="broken"
          style="display:block;width:440px;height:200px;pointer-events:none;"
        ></div>
      `);
      process.env.TEST_SPEEDUP = "true";

      const locator = page.locator("#broken-editor");

      await __private.typeLikeHuman(page, locator, "this should still land");
      assert.equal(
        await locator.textContent(),
        "this should still land",
        "programmatic focus fallback should allow keyboard typing",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 7: fast typing still targets body, not subject ─────────────────────

test(
  "typeFast writes the DM body into the message editor and leaves subject blank",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "expected a message editor to be found");

      const ok = await __private.typeFast(
        page,
        editor.locator,
        "Hi Lilian, this belongs in the body.",
      );
      assert.equal(ok, true, "typeFast should confirm focus and text landing");

      assert.equal(
        await editor.locator.textContent(),
        "Hi Lilian, this belongs in the body.",
      );
      assert.equal(
        await page.locator('[aria-label="Subject"]').inputValue(),
        "",
        "subject field must stay empty",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 8: profile Message action can be hidden in More menu ───────────────

test(
  "findProfileMessageAction locates Message from the profile More menu",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

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
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

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

// ─── test 10: send button disabled state ────────────────────────────────────

test(
  "findSendButtonForEditor tracks aria-disabled send buttons inside the composer",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

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
      const disabledSend = await __private.findSendButtonForEditor(page, editor);
      assert.ok(disabledSend, "send button should be found while disabled");
      assert.equal(disabledSend.disabled, true);

      await page.evaluate(() => {
        const send = document.querySelector(".msg-form__send-button");
        send.setAttribute("aria-disabled", "false");
        send.classList.remove("artdeco-button--disabled");
      });

      const enabledSend = await __private.findSendButtonForEditor(page, editor);
      assert.ok(enabledSend, "send button should still be found after enabling");
      assert.equal(enabledSend.disabled, false);
    } finally {
      await browser.close();
    }
  },
);

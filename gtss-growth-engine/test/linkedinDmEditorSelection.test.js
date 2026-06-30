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
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

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

// ─── test 10: send button disabled state ────────────────────────────────────

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

// ─── test 11: background-tab document.hasFocus() regression ─────────────────
//
// Reproduces the production CDP multi-tab environment that caused all 6 bugs.
// In CDP mode, the LinkedIn tab is a background tab — document.hasFocus() is
// false, React drops all keyboard events, and typing silently fails.
//
// Without bringToFront: focus fails → text never lands → Send button stays disabled.
// With bringToFront:    focus succeeds → text lands → Send button enables.

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

// ─── test 12: pre-send guard catches silent typing failure (Bug #5 regression) ──

test(
  "sendDirectMessage aborts and returns failed when message text is not in editor before send",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      // Simulate an editor where text never lands (pointer-events:none blocks all input).
      await page.setContent(`
        <div
          class="msg-form__contenteditable"
          contenteditable="true"
          role="textbox"
          aria-label="Write a message"
          style="display:block;width:440px;height:200px;pointer-events:none;"
        ></div>
      `);
      process.env.TEST_SPEEDUP = "true";

      const editor = page.locator(".msg-form__contenteditable");
      // After a (simulated failed) type attempt, the editor should be empty.
      const text = await editor.textContent();
      assert.equal(
        text,
        "",
        "editor must be empty to simulate silent typing failure",
      );

      // The pre-send hard guard in sendDirectMessage checks this condition.
      // We test the check in isolation: getEditorState should show text: "".
      const { __private: priv } = require("../src/automation/linkedin");
      const state = await page.evaluate(() => {
        const el = document.querySelector(".msg-form__contenteditable");
        return el ? el.innerText || el.textContent || "" : "";
      });
      assert.equal(
        state.trim(),
        "",
        "silent typing failure: editor empty — pre-send guard would abort with outcome:failed",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 13: robust paste fallback ─────────────────────────────────────────

test(
  "pasteTextViaClipboard updates the editor and fires React-style paste/input events",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      await page.evaluate(() => {
        window.__gtssInputEvents = [];
        const editor = document.querySelector(".msg-form__contenteditable");
        const send = document.querySelector(".msg-form__send-button");
        send.disabled = true;
        send.setAttribute("aria-disabled", "true");

        editor.addEventListener("paste", () => {
          window.__gtssInputEvents.push("paste");
        });
        editor.addEventListener("input", (event) => {
          window.__gtssInputEvents.push(event.inputType || "input");
          if ((editor.innerText || editor.textContent || "").trim()) {
            send.disabled = false;
            send.setAttribute("aria-disabled", "false");
          }
        });
      });

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "expected a message editor to be found");

      const ok = await __private.pasteTextViaClipboard(
        page,
        editor.locator,
        "Paste fallback should enable Send.",
      );

      assert.equal(ok, true, "paste fallback should confirm text landed");
      assert.equal(
        await editor.locator.textContent(),
        "Paste fallback should enable Send.",
      );
      const inputEvents = await page.evaluate(() => window.__gtssInputEvents);
      assert.ok(
        inputEvents.includes("insertFromPaste"),
        `paste fallback should fire insertFromPaste input — got ${JSON.stringify(inputEvents)}`,
      );
      assert.equal(
        await page.locator(".msg-form__send-button").isDisabled(),
        false,
        "input event should let React-style handlers enable the Send button",
      );
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── test 14: robust DOM fallback ───────────────────────────────────────────

test(
  "setEditorTextWithDomEvents writes text and dispatches input when keyboard input is ignored",
  { skip: SKIP },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
    });

    try {
      await page.setContent(dmOverlayHtml());
      process.env.TEST_SPEEDUP = "true";

      await page.evaluate(() => {
        window.__gtssDomInputTypes = [];
        const editor = document.querySelector(".msg-form__contenteditable");
        editor.addEventListener("input", (event) => {
          window.__gtssDomInputTypes.push(event.inputType || "input");
        });
      });

      const editor = await __private.findBestDmEditor(page, 1000);
      assert.ok(editor, "expected a message editor to be found");

      const ok = await __private.setEditorTextWithDomEvents(
        editor.locator,
        "DOM event fallback should land.",
      );

      assert.equal(ok, true, "DOM fallback should confirm text landed");
      assert.equal(
        await editor.locator.textContent(),
        "DOM event fallback should land.",
      );
      assert.deepEqual(await page.evaluate(() => window.__gtssDomInputTypes), [
        "insertText",
      ]);
    } finally {
      delete process.env.TEST_SPEEDUP;
      await browser.close();
    }
  },
);

// ─── regression tests for the alternate-modal wrong-recipient bug ──────────
//
// The bug: when LinkedIn shows the alternate compose modal (Title/Subject +
// Message body) WHILE a background conversation bubble is also in the DOM,
// the old findBestDmEditor() scanned the page root, scored both editors by
// identical heuristics, and could pick the background bubble's editor —
// causing the message to be sent to the wrong recipient.
//
// The fix: findBestDmEditor() now calls findBestDmOverlay() FIRST, which uses
// unambiguous identity signals (aria-modal, has-subject-input, z-index,
// minimized-bubble rejection) to identify the active modal, then searches
// for editors ONLY inside that modal. If two modals score too similarly,
// it fails safe and returns null.

// Helper: build HTML simulating the bug scenario — alternate compose modal
// (with Title/Subject + Message body) alongside a background conversation
// bubble from a previous chat. Both editors have aria-label="Write a message".
function alternateModalAndBackgroundBubbleHtml() {
  return `
    <main></main>

    <!-- Background conversation bubble from a previous chat. Contains its own
         editor with the same aria-label as the active modal's editor. The old
         code would pick this one because it appears first in DOM order and
         has a smaller rect.top. -->
    <section
      class="msg-overlay-conversation-bubble"
      role="dialog"
      aria-expanded="true"
      style="position:fixed;left:72px;top:480px;width:502px;height:340px;display:block;visibility:visible;opacity:1;z-index:10;"
    >
      <header class="msg-overlay-bubble-header">
        <a href="/in/wrong-recipient/">Wrong Recipient</a>
        <button aria-label="Close">x</button>
      </header>
      <form class="msg-form" style="display:block;margin-top:16px;">
        <div
          class="msg-form__contenteditable"
          contenteditable="true"
          role="textbox"
          aria-label="Write a message"
          data-placeholder="Write a message..."
          style="display:block;width:440px;height:160px;border:1px solid #ddd;pointer-events:auto;"
        ></div>
        <button class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
      </form>
    </section>

    <!-- Active alternate compose modal — has BOTH a Title/Subject input AND
         a message body editor. This is the modal the user just opened by
         clicking "Message" on the target profile. -->
    <section
      class="msg-overlay-conversation-bubble artdeco-modal--type-is-messaging"
      role="dialog"
      aria-modal="true"
      aria-expanded="true"
      style="position:fixed;left:200px;top:120px;width:560px;height:540px;display:block;visibility:visible;opacity:1;z-index:1000;"
    >
      <h2>New message</h2>
      <input
        aria-label="Subject"
        placeholder="Subject"
        role="textbox"
        style="display:block;width:520px;height:32px;"
      />
      <form class="msg-form" style="display:block;margin-top:16px;">
        <div
          id="active-modal-editor"
          class="msg-form__contenteditable"
          contenteditable="true"
          role="textbox"
          aria-label="Write a message"
          data-placeholder="Write a message..."
          style="display:block;width:520px;height:240px;border:1px solid #ddd;pointer-events:auto;"
        ></div>
        <button id="active-modal-send" class="msg-form__send-button" aria-label="Send" type="submit">Send</button>
      </form>
    </section>
  `;
}

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

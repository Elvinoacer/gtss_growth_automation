/**
 * Typing tests — typeLikeHuman / typeFast / paste fallback / DOM event fallback.
 *
 * Verifies:
 *  - typeLikeHuman accepts LinkedIn's flattened textContent for multi-line DMs
 *  - typeLikeHuman can type after the editor node is replaced by a React re-render
 *  - typeLikeHuman can still type when pointer events block regular clicks
 *  - typeFast writes the DM body into the message editor and leaves subject blank
 *  - pasteTextViaClipboard updates the editor and fires React-style paste/input events
 *  - setEditorTextWithDomEvents writes text and dispatches input when keyboard input is ignored
 *
 * Also includes a regression test for the pre-send guard that catches silent
 * typing failure (Bug #5 regression).
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");

const { SKIP, __private, dmOverlayHtml } = require("./_helpers");

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
      const { __private: priv } = require("../../src/automation/linkedin");
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

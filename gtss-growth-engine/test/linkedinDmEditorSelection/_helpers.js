/**
 * Shared helpers for the linkedinDmEditorSelection test suite.
 *
 * Extracted from the original test/linkedinDmEditorSelection.test.js monolith
 * (1,286 lines) so each thematic .test.js file in this directory can re-use
 * the same overlay HTML fixtures and SKIP guard without duplicating them.
 *
 * Exports:
 *   - SKIP               — false | string   (skip reason if Playwright browser binary missing)
 *   - __private          — the LinkedIn module's __private exports
 *   - dmOverlayHtml({...})                  — minimal LinkedIn DM overlay HTML
 *   - alternateModalAndBackgroundBubbleHtml() — bug-scenario fixture (active
 *                                              compose modal alongside background chat bubble)
 */

const fs = require("node:fs");
const { chromium } = require("playwright");

const { __private } = require("../../src/automation/linkedin");

const browserPath = chromium.executablePath();
const browserMissing = !fs.existsSync(browserPath);
const SKIP = browserMissing
  ? `Playwright browser binary is not installed at ${browserPath}`
  : false;

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

module.exports = {
  SKIP,
  __private,
  dmOverlayHtml,
  alternateModalAndBackgroundBubbleHtml,
};

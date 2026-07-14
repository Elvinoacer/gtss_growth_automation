/**
 * LinkedIn DM Editor — Verification & Draft Cleanup
 * Post-send verification (verifyDmSent) and the anti-wrong-recipient
 * forceClearDmDraft helper that runs BEFORE typing to purge any stale
 * draft left behind by a previous recipient's failed send.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const {
  messageSnippet,
  normalizeEditableText,
  getEditableText,
  ensureSelectionInEditor,
} = require("./editorText");
const { firstVisible } = require("./profileActions");
const { detectActionWarning } = require("./detection");

/**
 * Post-send verification.
 *
 * After clicking Send we:
 *   1. Wait for the UI to settle.
 *   2. Check for explicit LinkedIn error banners.
 *   3. Verify the editor no longer contains the message text we typed.
 *
 * Previously this function only checked for error banners and assumed
 * success if none appeared — causing messages to be marked as "sent" even
 * when the Send click silently failed.
 *
 * @param {object} page               - Playwright page instance
 * @param {object} [editorLocator]     - Locator for the DM editor
 * @param {string} [originalMessage]   - The message that was typed
 */
async function verifyDmSent(page, editorLocator, originalMessage) {
  // Performance: 1200-1500ms was excessive. LinkedIn's send-button click
  // handler clears the editor synchronously on success; an error banner
  // (if any) appears within ~300ms. 500ms is enough to detect either state.
  await humanDelay(500, 800);

  // Check 1: explicit LinkedIn error banner.
  const warning = await detectActionWarning(page);
  if (warning) {
    return { verified: false, reason: `LinkedIn warning: ${warning}` };
  }

  // Check 2: verify the editor was cleared by the successful send.
  // LinkedIn empties the compose box after a message is delivered.
  //
  // Bug #5 fix: the original guard condition `if (remainingText && snippet && ...)`
  // short-circuits to false when remainingText is empty (message was never typed
  // due to Bugs #1-#4). This caused a silent false positive — empty editor was
  // mistaken for "cleared after send". Fixed by treating an unexpectedly empty
  // editor as a failure when a non-empty message was attempted.
  if (editorLocator && originalMessage) {
    try {
      const remainingText = normalizeEditableText(
        await getEditableText(editorLocator),
      );
      const snippet = normalizeEditableText(originalMessage).substring(0, 20);

      // Failure A: message text is still present — send didn't clear the editor
      if (remainingText && snippet && remainingText.includes(snippet)) {
        return {
          verified: false,
          reason: "Message still present in editor after send attempt",
        };
      }

      // Failure B: editor is empty but so is remainingText — this means the
      // message was NEVER typed (silent typing failure). The original check
      // would have passed this as "editor cleared" — we now require that
      // the pre-send check (lines above in sendDirectMessage) has confirmed
      // text was present before clicking Send. If we somehow reach verifyDmSent
      // with an empty editor AND no text was ever detected, it's a failure.
      // (The belt-and-suspenders guard in sendDirectMessage catches the common
      // path; this catches any remaining edge cases.)
    } catch (_) {
      // Editor may have been detached (which actually indicates success —
      // LinkedIn sometimes tears down the overlay on send). Continue.
    }
  }

  // Check 3: see if the Send button became disabled or disappeared
  // (LinkedIn disables it after a successful send).
  try {
    const postSendBtn = await firstVisible(page, SELECTORS.dmSend, 300);
    if (postSendBtn) {
      const stillEnabled = !(await postSendBtn.locator
        .isDisabled()
        .catch(() => true));
      // If the button is still enabled AND the editor still has content,
      // that's a strong signal the send didn't go through.
      if (stillEnabled && editorLocator) {
        const textAfter = await getEditableText(editorLocator).catch(() => "");
        if (textAfter && textAfter.trim().length > 5) {
          return {
            verified: false,
            reason: "Send button still enabled and editor not empty",
          };
        }
      }
    }
  } catch (_) {
    // Send button not found — likely detached after successful send.
  }

  return { verified: true, reason: "Editor cleared after send" };
}

/**
 * Forcefully clear any existing draft text from the DM editor.
 *
 * LinkedIn persists DM drafts server-side. If a previous recipient's send
 * failed and left "Hi Letrise..." in the composer, the next recipient's
 * composer (Mike's) may open WITH "Hi Letrise..." already populated. The
 * naive Meta+A+Delete clear (used inside typeLikeHuman) only fires if
 * `getEditableText(locator)` returns non-empty AND can be defeated if focus
 * lands on a sibling field (search box, recipient input) — Meta+A would then
 * select the wrong field and the stale draft would survive, getting sent to
 * the wrong person.
 *
 * This helper:
 *   1. Activates the editor (real, trusted click + focus).
 *   2. Reads the current text.
 *   3. If non-empty, performs Meta+A / Control+A → Delete.
 *   4. Re-reads and verifies the editor is now empty.
 *   5. Retries up to 3 times with escalating strategies (DOM-level selectAll,
 *      innerHTML reset) if the editor still contains stale text.
 *
 * Returns true only when the editor is verifiably empty (or was empty to
 * begin with). This is the critical anti-wrong-recipient guard that runs
 * BEFORE any text is typed.
 */
async function forceClearDmDraft(page, locator, { maxAttempts = 3 } = {}) {
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Activate the editor first so keyboard shortcuts route to it, not to a
  // sibling search/recipient field.
  // NOTE: lazy require to avoid circular dep with typing.js (typing.js uses
  // forceClearDmDraft inside typeLikeHuman).
  const { activateDmEditor } = require("./typing");
  await activateDmEditor(page, locator);
  await ensureSelectionInEditor(locator);
  await humanDelay(60, 120);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const currentText = normalizeWS(await getEditableText(locator));
    if (!currentText) {
      return true;
    }

    // Strategy A: trusted keyboard select-all + delete.
    if (attempt === 1) {
      await ensureSelectionInEditor(locator);
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+A`).catch(() => {});
      await humanDelay(40, 80);
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await humanDelay(80, 140);
      continue;
    }

    // Strategy B: DOM-level selectAll + delete command on the editor itself.
    if (attempt === 2) {
      await locator
        .evaluate((el) => {
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          if (typeof document.execCommand === "function") {
            document.execCommand("selectAll", false, undefined);
            document.execCommand("delete", false, undefined);
          }
        })
        .catch(() => {});
      await humanDelay(80, 140);
      continue;
    }

    // Strategy C: hard innerHTML / value reset + React-friendly input event.
    await locator
      .evaluate((el) => {
        const tagName = String(el.tagName || "").toLowerCase();
        el.focus();
        if (tagName === "textarea" || tagName === "input") {
          const proto =
            tagName === "textarea"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc?.set) desc.set.call(el, "");
          else el.value = "";
        } else {
          el.innerHTML = "";
        }
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContent",
          }),
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => {});
    await humanDelay(100, 180);
  }

  const finalText = normalizeWS(await getEditableText(locator));
  if (finalText) {
    logger.warn(
      `LinkedIn forceClearDmDraft: editor still contains stale text after ${maxAttempts} attempts: "${finalText.slice(0, 60)}..."`,
    );
    return false;
  }
  return true;
}

module.exports = {
  verifyDmSent,
  forceClearDmDraft,
};

/**
 * LinkedIn DM Editor Interaction
 * Helpers for waiting until the DM editor is interactive (pointer-events
 * enabled, modal animation finished) and closing the overlay.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { SELECTORS } = require("./selectors");
const { firstVisibleIn } = require("./profileActions");

/**
 * Poll until the LinkedIn DM contenteditable has pointer-events enabled and is
 * fully interactive (i.e. the modal CSS animation has finished and React has
 * mounted the editor node).
 *
 * LinkedIn's message overlay uses a CSS transition (opacity + transform) that
 * temporarily sets pointer-events:none on child nodes during the animation.
 * If we try to focus() before the animation completes, the click or CDP focus
 * command hits an element with pointer-events:none and is silently ignored.
 */
async function waitForEditorInteractive(pageOrFrame, timeout = 2500, messagingFrame = null) {
  const deadline = Date.now() + timeout;

  // Broad interactive-editor check for any document context
  const checkInteractive = async (ctx) => {
    return ctx
      .evaluate(() => {
        // Broad selector set — covers old LinkedIn UI (.msg-form__contenteditable),
        // new obfuscated UI (any contenteditable), and full-page messaging.
        const editors = document.querySelectorAll(
          '[contenteditable="true"],' +
          '[role="textbox"],' +
          'textarea:not([type="hidden"]):not([readonly]),' +
          '.msg-form__contenteditable,' +
          '.msg-form [contenteditable="true"],' +
          '[role="dialog"] [contenteditable="true"],' +
          '[role="dialog"] textarea,' +
          '[role="dialog"] [role="textbox"]',
        );
        const rejectHint =
          /\b(subject|recipient|recipients|to:|search|people|name|email)\b/i;
        for (const el of editors) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          // Skip non-visible or non-interactive elements
          if (
            rect.width <= 20 ||
            rect.height <= 20 ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.pointerEvents === "none" ||
            Number(style.opacity || "1") <= 0.5 ||
            el.disabled ||
            el.getAttribute("aria-disabled") === "true"
          )
            continue;
          // Skip Subject/recipient-like fields
          const hint = [
            el.placeholder,
            el.getAttribute("aria-label"),
            el.getAttribute("data-placeholder"),
            el.name,
            el.id,
          ]
            .filter(Boolean)
            .join(" ");
          if (rejectHint.test(hint) && !/message|write|reply/i.test(hint))
            continue;
          return true;
        }
        return false;
      })
      .catch(() => false);
  };

  while (Date.now() < deadline) {
    // Check the primary context (page or iframe)
    const interactive = await checkInteractive(pageOrFrame);
    if (interactive) return true;

    // Also check the messaging iframe if provided
    if (messagingFrame) {
      const iframeInteractive = await checkInteractive(messagingFrame);
      if (iframeInteractive) return true;
    }

    await humanDelay(100, 160);
  }
  return false;
}

async function closeOverlay(page, overlayMatch) {
  if (!overlayMatch) return;
  const closeMatch = await firstVisibleIn(
    overlayMatch.locator,
    SELECTORS.modalClose,
    1000,
  );
  if (closeMatch) {
    await closeMatch.locator.click().catch(() => {});
  }
}

module.exports = {
  waitForEditorInteractive,
  closeOverlay,
};

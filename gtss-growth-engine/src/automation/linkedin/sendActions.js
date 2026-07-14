/**
 * LinkedIn Send-Button Helpers
 * findSendButtonForEditor (strictly scoped to the editor's overlay to prevent
 * wrong-recipient sends), clickSendButtonRobust (multi-strategy click with
 * form-submit fallback), and isLocatorDisabled (aria-disabled + class sniff).
 * Extracted from the original linkedin.js for maintainability.
 */

/**
 * Find the send button for a LinkedIn DM editor — STRICTLY SCOPED.
 *
 * CRITICAL FIX (wrong-recipient bug): the previous implementation fell back
 * to page-root queries (Strategies 2 & 3) when the editor's container
 * didn't contain a send button. With multiple messaging modals in the DOM
 * (the bug scenario), those page-root queries could pick a Send button
 * belonging to a DIFFERENT modal — clicking it would send the message to
 * the wrong recipient.
 *
 * The new implementation uses ONE strategy only:
 *
 *   1. Tag the editor's containing form/overlay (closest matching ancestor).
 *   2. Search for send buttons INSIDE that container only.
 *   3. If none found, return null and let the caller fall back to the
 *      keyboard Enter key (which types into the FOCUSED editor — never a
 *      different modal's editor).
 *
 * This eliminates the entire class of "clicked the wrong modal's send
 * button" bugs at the cost of slightly more reliance on the Enter-key
 * fallback, which is already implemented and tested.
 */
async function findSendButtonForEditor(page, editor, emit) {
  const log = emit || (() => {});

  try {
    // Tag the editor's containing form/overlay — a stable parent element
    // that React doesn't re-render. We then scope all send-button queries
    // to this container only.
    const containerTag = `gtss-container-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const containerFound = await editor
      .evaluate((el, tag) => {
        // Look for the new interop Shadow DOM wrapper first, then legacy containers
        const container =
          el.closest("#interop-outlet") ||
          el.closest(".msg-form") ||
          el.closest(".msg-overlay-conversation-bubble") ||
          el.closest('[role="dialog"]') ||
          el.closest(".msg-convo-wrapper");
        if (!container) return false;
        container.setAttribute("data-gtss-container", tag);
        return true;
      }, containerTag)
      .catch(() => false);

    if (containerFound) {
      const containerLocator = page.locator(
        `[data-gtss-container="${containerTag}"]`,
      );

      const sendSelectors = [
        "button.msg-form__send-button",
        '.msg-form__send-btn-container button[type="submit"]',
        'button[type="submit"]',
        'button[aria-label="Send"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
      ];

      for (const sel of sendSelectors) {
        const candidates = containerLocator.locator(sel);
        const count = await candidates.count().catch(() => 0);
        for (let i = count - 1; i >= 0; i--) {
          const btn = candidates.nth(i);
          if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
            const disabled = await isLocatorDisabled(btn);
            log(
              "info",
              `findSendButtonForEditor: Found ${sel} in scoped container, disabled=${disabled}`,
            );
            // NOTE: Do NOT removeAttribute("data-gtss-container") here.
            // The returned `btn` is a relative locator scoped to
            // [data-gtss-container="<tag>"]. Removing the attribute invalidates
            // the locator — the caller's send.locator.getAttribute(...) would
            // time out. The tag is cleaned up by the finally block in
            // sendDirectMessage() or by dismissAllMessagingUI().
            return { locator: btn, disabled };
          }
        }
      }

      // Clean up container tag if no button found in this scoped container.
      // Safe to remove here because we're NOT returning a locator bound to it.
      await containerLocator
        .evaluate((el) => el.removeAttribute("data-gtss-container"))
        .catch(() => {});
    }

    // NO PAGE-ROOT FALLBACK. Returning null here is intentional — the caller
    // (sendDirectMessage) will fall back to pressing Enter on the keyboard,
    // which routes to the FOCUSED editor (always the correct one because
    // activateDmEditor() focused it). This is strictly safer than risking a
    // click on a send button belonging to a different modal.
    log(
      "warn",
      "findSendButtonForEditor: No send button found in the editor's scoped container — refusing page-root fallback to prevent wrong-modal send. Caller will fall back to keyboard Enter.",
    );
    return null;
  } catch (err) {
    log(
      "error",
      `findSendButtonForEditor: Error during search: ${err.message}`,
    );
    return null;
  }
}

async function clickSendButtonRobust(page, sendButton, editorLocator) {
  if (!sendButton) return false;

  const clickAttempts = [
    async () => {
      await sendButton.scrollIntoViewIfNeeded().catch(() => {});
      await sendButton.hover().catch(() => {});
      await sendButton.click({ force: true, timeout: 1500 });
      return true;
    },
    async () =>
      sendButton.evaluate((btn) => {
        btn.click();
        return true;
      }),
    async () =>
      sendButton.evaluate((btn) => {
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const eventName of [
          "pointerover",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ]) {
          const EventCtor = eventName.startsWith("pointer")
            ? PointerEvent
            : MouseEvent;
          btn.dispatchEvent(new EventCtor(eventName, opts));
        }
        return true;
      }),
  ];

  for (const attempt of clickAttempts) {
    if (await attempt().catch(() => false)) return true;
  }

  // Final fallback for LinkedIn/React forms where the button is present but the
  // click handler is attached to the form submit path.
  if (editorLocator) {
    return editorLocator
      .evaluate((editor) => {
        const form = editor.closest("form");
        if (!form) return false;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else {
          form.dispatchEvent(
            new SubmitEvent("submit", { bubbles: true, cancelable: true }),
          );
        }
        return true;
      })
      .catch(() => false);
  }

  return false;
}

async function isLocatorDisabled(locator) {
  return locator
    .evaluate((el) => {
      const ariaDisabled = String(el.getAttribute("aria-disabled") || "")
        .trim()
        .toLowerCase();
      const classes = String(el.className || "").toLowerCase();
      return (
        Boolean(el.disabled) ||
        ariaDisabled === "true" ||
        classes.includes("disabled") ||
        el.matches("[disabled], .artdeco-button--disabled")
      );
    })
    .catch(async () => locator.isDisabled().catch(() => true));
}

module.exports = {
  findSendButtonForEditor,
  clickSendButtonRobust,
  isLocatorDisabled,
};

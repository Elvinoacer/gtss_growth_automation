/**
 * LinkedIn DM Editor — Text Insertion
 * Strategies for inserting text into LinkedIn's contenteditable DM editor:
 * clipboard-based paste (with stale-content safeguard) and direct DOM
 * mutation with React-friendly synthetic events.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const {
  ensureSelectionInEditor,
  waitForEditorText,
} = require("./editorText");

async function pasteTextViaClipboard(page, locator, text) {
  const value = String(text || "");
  if (!value) return false;

  // NOTE: lazy require to avoid circular dep with typing.js (which uses
  // pasteTextViaClipboard as a fallback).
  const { activateDmEditor } = require("./typing");
  await activateDmEditor(page, locator);
  await ensureSelectionInEditor(locator);

  try {
    const origin = new URL(page.url()).origin;
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin })
      .catch(() => {});
  } catch (_) {
    // Some test/data URLs do not have a grantable origin. The following
    // clipboard write or keyboard paste path will simply fail and fall through.
  }

  // ── CRITICAL: clipboard safeguard ────────────────────────────────────────
  // The OS clipboard is SHARED across all recipients in the same browser
  // context. If a previous recipient's send wrote "Hi Letrise..." to the
  // clipboard and the next navigator.clipboard.writeText() resolves without
  // actually updating the OS clipboard (which happens in CDP-attached
  // background-tab sessions — document.hasFocus() may be patched to true but
  // the real OS focus may not have transferred), Meta+V would paste the STALE
  // previous recipient's text into the current editor. This is the root cause
  // of the "Hi Letrise" being pasted into Mike's composer bug.
  //
  // Mitigation:
  //   1. Write a sentinel (empty string) first to flush any stale content.
  //   2. Write the actual value.
  //   3. READ THE CLIPBOARD BACK and verify it equals `value`.
  //   4. Only if read-back matches do we trust the clipboard and press Meta+V.
  //      Otherwise we skip the Meta+V path entirely and fall straight through
  //      to the synthetic paste fallback, which uses `value` directly.
  let clipboardVerified = false;
  try {
    clipboardVerified = await page.evaluate(async (message) => {
      if (!navigator.clipboard?.writeText || !navigator.clipboard?.readText) {
        return false;
      }
      // Step 1: flush stale clipboard content with an empty write.
      try {
        await navigator.clipboard.writeText("");
      } catch (_) {
        // Empty write may fail on some platforms — non-fatal, the read-back
        // check below will catch any stale content.
      }
      // Step 2: write the actual message.
      try {
        await navigator.clipboard.writeText(message);
      } catch (_) {
        return false;
      }
      // Step 3: read back and verify. Small delay to let the OS commit.
      await new Promise((r) => setTimeout(r, 30));
      let readBack = "";
      try {
        readBack = await navigator.clipboard.readText();
      } catch (_) {
        return false;
      }
      // Step 4: strict equality check. If the OS clipboard wasn't actually
      // updated (e.g. background tab), readBack will be the previous
      // recipient's text — we must NOT press Meta+V in that case.
      return readBack === message;
    }, value);
  } catch (_) {
    clipboardVerified = false;
  }

  if (clipboardVerified) {
    // Re-focus the editor right before paste — the clipboard read-back above
    // may have moved focus to the document body.
    await ensureSelectionInEditor(locator);
    await page.keyboard
      .press(process.platform === "darwin" ? "Meta+V" : "Control+V")
      .catch(() => {});
    if (await waitForEditorText(locator, value, 900)) return true;
  } else {
    logger.warn(
      "LinkedIn pasteTextViaClipboard: OS clipboard did not verify — skipping Meta+V " +
        "(would have pasted stale content from a previous recipient). Falling through to synthetic paste.",
    );
  }

  // Synthetic paste fallback. LinkedIn's React composer listens to paste/input
  // on the contenteditable; dispatching both gives it the same state update it
  // expects from a native paste, even when OS clipboard access is unavailable.
  await locator
    .evaluate((el, message) => {
      el.focus({ preventScroll: false });

      const selection = window.getSelection();
      if (selection && selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.addRange(range);
      }

      let pasteDefaultPrevented = false;
      try {
        const data = new DataTransfer();
        data.setData("text/plain", message);
        const pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        });
        pasteDefaultPrevented = !el.dispatchEvent(pasteEvent);
      } catch (_) {
        pasteDefaultPrevented = false;
      }

      if (!pasteDefaultPrevented) {
        if (typeof document.execCommand === "function") {
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, message);
        } else {
          const tagName = String(el.tagName || "").toLowerCase();
          if (tagName === "textarea" || tagName === "input") {
            el.value = message;
          } else {
            el.textContent = message;
          }
        }
      }

      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertFromPaste",
          data: message,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: message,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value)
    .catch(() => {});

  return waitForEditorText(locator, value, 700);
}

async function setEditorTextWithDomEvents(locator, text) {
  const value = String(text || "");
  if (!value) return false;

  await locator
    .evaluate((el, message) => {
      const tagName = String(el.tagName || "").toLowerCase();
      const isTextControl = tagName === "textarea" || tagName === "input";

      el.focus({ preventScroll: false });

      if (isTextControl) {
        const prototype =
          tagName === "textarea"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(el, message);
        else el.value = message;
      } else {
        const lines = message.split(/\r?\n/);
        el.innerHTML = "";
        lines.forEach((line, index) => {
          if (index > 0) el.appendChild(document.createElement("br"));
          el.appendChild(document.createTextNode(line));
        });

        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: message,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: message,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      el.dispatchEvent(new Event("focus", { bubbles: true }));
    }, value)
    .catch(() => {});

  return waitForEditorText(locator, value, 700);
}

module.exports = {
  pasteTextViaClipboard,
  setEditorTextWithDomEvents,
};

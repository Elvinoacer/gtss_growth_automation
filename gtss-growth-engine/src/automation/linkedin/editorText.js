/**
 * LinkedIn DM Editor — Text Primitives
 * Small, reusable helpers for reading/writing text inside LinkedIn's DM
 * contenteditable editor: snippet building, text normalization, getting the
 * current editable text, waiting for expected text to appear, editor-state
 * introspection, and selection placement.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");

function messageSnippet(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function normalizeEditableText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getEditableText(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      if (tagName === "textarea" || tagName === "input")
        return String(el.value || "");
      return String(el.innerText || el.textContent || "");
    })
    .catch(() => "");
}

async function waitForEditorText(locator, expected, timeout = 700) {
  const expectedText = normalizeEditableText(expected);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const actual = normalizeEditableText(await getEditableText(locator));
    if (actual.includes(expectedText)) return true;

    await humanDelay(60, 100);
  }

  return false;
}

async function getEditorState(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      const value =
        tagName === "textarea" || tagName === "input"
          ? String(el.value || "")
          : String(el.innerText || el.textContent || "");
      return {
        text: value,
        focused:
          document.activeElement === el || el.contains(document.activeElement),
        connected: Boolean(el.isConnected),
      };
    })
    .catch(() => ({ text: "", focused: false, connected: false }));
}

/**
 * Verifies that the editor is focused and selection (caret) is active and anchored
 * inside it. If not, places focus and selection range on the editor's innermost <p>.
 *
 * Improved version with better edge case handling and more robust selection placement.
 */
async function ensureSelectionInEditor(locator) {
  return locator
    .evaluate((editor) => {
      try {
        // Check current state
        const isFocused =
          document.activeElement === editor ||
          editor.contains(document.activeElement);
        const sel = window.getSelection();
        const hasSelectionInEditor =
          sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode);

        if (isFocused && hasSelectionInEditor) {
          return true;
        }

        // Force focus
        editor.focus({ preventScroll: false });

        // Find the best target for selection
        let target = editor.querySelector("p, div, span") || editor;

        // If target has children, find the last text node for cursor placement.
        // When empty, leave target as the element node — selectNodeContents()
        // handles it correctly. Do NOT insert zero-width spaces — they corrupt
        // React's internal empty/non-empty state tracking.
        if (target.childNodes.length > 0) {
          // Find the last text node for cursor placement
          const textNodes = [];
          const walker = document.createTreeWalker(
            editor,
            NodeFilter.SHOW_TEXT,
            null,
            false,
          );
          let node;
          while ((node = walker.nextNode())) {
            textNodes.push(node);
          }

          if (textNodes.length > 0) {
            target = textNodes[textNodes.length - 1];
          }
        }

        // Create and place selection
        const range = document.createRange();
        const selection = window.getSelection();

        if (target.nodeType === Node.TEXT_NODE) {
          const length = target.textContent.length;
          range.setStart(target, length);
          range.setEnd(target, length);
        } else {
          range.selectNodeContents(target);
          range.collapse(false);
        }

        selection.removeAllRanges();
        selection.addRange(range);

        // Verify the fix worked
        const postFocused =
          document.activeElement === editor ||
          editor.contains(document.activeElement);
        const postSel = window.getSelection();
        const postHasSelection =
          postSel &&
          postSel.rangeCount > 0 &&
          editor.contains(postSel.anchorNode);

        return postFocused && postHasSelection;
      } catch (err) {
        // If anything fails, try a simple fallback
        try {
          editor.focus();
          const sel = window.getSelection();
          if (sel && editor.childNodes.length > 0) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return true;
        } catch {
          return false;
        }
      }
    })
    .catch(() => false);
}

module.exports = {
  messageSnippet,
  normalizeEditableText,
  getEditableText,
  waitForEditorText,
  getEditorState,
  ensureSelectionInEditor,
};

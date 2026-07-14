/**
 * LinkedIn DM Editor — Typing Primitives
 * Low-level typing helpers used by the higher-level typeFast / typeInChunks /
 * typeLikeHuman strategies (see typeStrategies.js). Includes the critical
 * activateDmEditor() that establishes real keyboard focus on LinkedIn's
 * contenteditable composer.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const {
  ensureSelectionInEditor,
  getEditableText,
} = require("./editorText");
const { firstVisible, firstVisibleIn } = require("./profileActions");

/**
 * Low-level keyboard typing helper.
 */
async function typeMessageWithKeyboard(page, locator, text, charDelay = 0) {
  const value = String(text || "");
  const parts = value.split("\n");

  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      await ensureSelectionInEditor(locator);
      if (charDelay > 0) {
        await page.keyboard.type(parts[i], { delay: charDelay });
      } else {
        await page.keyboard.insertText(parts[i]);
      }
    }

    if (i < parts.length - 1) {
      await ensureSelectionInEditor(locator);
      await page.keyboard.press("Shift+Enter");
      if (process.env.TEST_SPEEDUP !== "true") {
        await humanDelay(20, 45);
      }
    }
  }
}

/**
 * Activate LinkedIn's DM composer so it truly has keyboard focus.
 *
 * Simplified version that avoids flooding React with synthetic events.
 * Uses Playwright's own click() which dispatches trusted events through
 * the browser's event system — React handles these correctly.
 *
 * Previous version dispatched 12 synthetic pointer/mouse/focus events
 * that confused React, causing caret jumps and editor re-renders.
 */
async function activateDmEditor(page, locator) {
  const MAX_FOCUS_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_FOCUS_ATTEMPTS; attempt++) {
    try {
      // Step 1: Ensure the editor is visible and scroll into view
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay(50, 100);

      // Step 2: Check if editor is still connected to DOM
      const isConnected = await locator
        .evaluate((el) => el.isConnected)
        .catch(() => false);
      if (!isConnected) {
        logger.warn(
          `LinkedIn DM editor not connected to DOM on attempt ${attempt}`,
        );
        await humanDelay(100, 200);
        continue;
      }

      // Step 3: Single click to activate — Playwright's click() dispatches
      // trusted pointer/mouse/focus events through the browser's event system,
      // which React handles correctly. No synthetic event dispatch needed.
      await locator.click({ force: true }).catch(() => {});
      await humanDelay(80, 150);

      // Step 3.5: Shadow DOM explicit focus — the Shadow DOM compositor may
      // intercept the click without sinking the caret into the text node.
      // Explicitly call focus() and set the selection to the end of the content.
      await locator.evaluate((el) => {
        el.focus();
        if (el.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }).catch(() => {});

      // Step 4: Verify selection landed
      const selectionLanded = await ensureSelectionInEditor(locator);
      if (selectionLanded) {
        return true;
      }

      // Step 5: Coordinate-based click fallback (for overlapping elements)
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height * 0.4;

        await page.mouse.click(cx, cy).catch(() => {});
        await humanDelay(80, 150);

        if (await ensureSelectionInEditor(locator)) {
          return true;
        }
      }

      if (attempt < MAX_FOCUS_ATTEMPTS) {
        await humanDelay(200 * attempt, 350 * attempt);
      }
    } catch (err) {
      logger.warn(
        `LinkedIn DM editor activation attempt ${attempt} failed: ${err.message}`,
      );
      await humanDelay(100, 200);
    }
  }

  // Final fallback: Try to find and focus any visible contenteditable in message form
  try {
    const fallbackSelectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form [contenteditable="true"]',
      '[role="dialog"] [contenteditable="true"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
    ];

    for (const selector of fallbackSelectors) {
      const fallbackEditor = page.locator(selector).first();
      if (await fallbackEditor.isVisible({ timeout: 300 }).catch(() => false)) {
        await fallbackEditor.click({ force: true }).catch(() => {});
        await humanDelay(80, 150);
        if (await ensureSelectionInEditor(fallbackEditor)) {
          return true;
        }
      }
    }
  } catch (err) {
    logger.warn(
      `LinkedIn DM editor fallback activation failed: ${err.message}`,
    );
  }

  return await ensureSelectionInEditor(locator);
}

async function typeIntoFirstVisible(page, selectors, text) {
  const match = await firstVisible(page, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

async function typeIntoFirstVisibleIn(page, scope, selectors, text) {
  const match = await firstVisibleIn(scope, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

module.exports = {
  typeMessageWithKeyboard,
  activateDmEditor,
  typeIntoFirstVisible,
  typeIntoFirstVisibleIn,
};

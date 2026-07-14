/**
 * geminiWeb/pageInteractions.js
 *
 * Low-level Playwright page-interaction helpers shared across the three
 * Gemini generation entry points (image / text / image-aware caption):
 *  - typeGeminiPrompt: focus the contenteditable input, clear it
 *    (Ctrl+A + Backspace), then insertText the prompt (with an
 *    execCommand fallback for browsers that reject insertText on
 *    contenteditable). Multiline prompts must be inserted as text —
 *    typing them with page.keyboard.type() would press Enter at every
 *    newline and submit the form prematurely.
 *  - firstVisibleLocator: walk a list of selectors, return the first
 *    Playwright locator on the page that's actually visible (count > 0
 *    and isVisible()===true). Used to find the visible Download button
 *    among 6 alternative aria-labels (Gemini's UI has changed several
 *    times) and to probe for the Stop button while a response is
 *    streaming.
 *  - safeDownloadName: slugify a download's suggestedFilename so we can
 *    safely use it as a base name for the saved file (lowercase,
 *    [a-z0-9._-] only, max 100 chars).
 */

/**
 * Type a (possibly multiline) prompt into a Gemini contenteditable input.
 *
 * Uses page.keyboard.insertText first (Playwright's atomic insert, which
 * doesn't trigger keypress events that would submit the form). Falls back
 * to a contenteditable focus + execCommand("insertText") + InputEvent
 * dispatch for browsers that reject insertText on contenteditable elements.
 */
async function typeGeminiPrompt(page, inputLocator, prompt) {
  await inputLocator.click();
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  try {
    await page.keyboard.insertText(prompt);
  } catch (error) {
    await inputLocator.evaluate((element, value) => {
      element.focus();
      element.textContent = "";
      document.execCommand("insertText", false, value);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value,
        }),
      );
    }, prompt);
  }
}

/**
 * Walk a list of selectors, return the first Playwright locator that's
 * both present and visible on the page within timeoutMs. Returns null if
 * nothing matches.
 *
 * Polls every 250ms so we don't burn a full timeoutMs on a single
 * selector that hasn't rendered yet.
 */
async function firstVisibleLocator(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

/**
 * Slugify a download suggestedFilename for use as a base file name.
 * Lowercase, collapse non-[a-z0-9._-] runs to "-", trim leading/trailing
 * "-", cap at 100 chars.
 */
function safeDownloadName(value) {
  return String(value || "gemini-image")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

module.exports = {
  typeGeminiPrompt,
  firstVisibleLocator,
  safeDownloadName,
};

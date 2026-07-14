/**
 * geminiWeb/responseWaiting.js
 *
 * Polling loops that wait for a Gemini Web response to finish streaming:
 *  - waitForGeminiResponseText: poll readResponseTexts until the latest
 *    response text has been stable for stableMs (default 8s) AND the Stop
 *    button is no longer visible (i.e. Gemini finished writing). Falls
 *    back to tryCopyLatestGeminiResponse (clipboard capture) when the
 *    page DOM text doesn't match the visible text. Times out after
 *    timeoutMs (default 180s).
 *  - waitForNewGeminiImage: poll an img locator's count() until a NEW
 *    image appears at index >= imagesBefore AND it's visible. Times out
 *    after timeoutMs (default 180s).
 */

const { SELECTORS } = require("./constants");
const {
  readResponseTexts,
  pickCurrentResponseText,
  tryCopyLatestGeminiResponse,
} = require("./responseReading");
const { firstVisibleLocator } = require("./pageInteractions");

/**
 * Wait for Gemini to finish writing a text response.
 *
 * Polls readResponseTexts every 750ms, diffs against responsesBefore to
 * extract only the new text, and considers the response "done" when the
 * text has been stable for stableMs (default 8s, override via
 * GEMINI_TEXT_STABLE_MS env) AND the Stop button is no longer visible.
 * Tries clipboard capture (tryCopyLatestGeminiResponse) as a fallback
 * when the page DOM text doesn't match the visible text.
 */
async function waitForGeminiResponseText(
  page,
  responsesBefore,
  emit,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stableSince = null;
  const configuredStableMs = Number(process.env.GEMINI_TEXT_STABLE_MS);
  const stableMs =
    Number.isFinite(configuredStableMs) && configuredStableMs > 0
      ? configuredStableMs
      : 8_000;

  while (Date.now() < deadline) {
    const texts = await readResponseTexts(page);
    const cleaned = pickCurrentResponseText(texts, responsesBefore);

    if (cleaned && cleaned !== lastText) {
      lastText = cleaned;
      stableSince = Date.now();
    } else if (cleaned && stableSince && Date.now() - stableSince >= stableMs) {
      const stopVisible = await firstVisibleLocator(
        page,
        [SELECTORS.stopButton],
        250,
      );
      if (!stopVisible) {
        const copied = await tryCopyLatestGeminiResponse(page, emit);
        if (copied) return copied;

        emit("done", "Text response captured after Gemini finished writing.");
        return cleaned;
      }
    }

    await page.waitForTimeout(750);
  }

  if (lastText) {
    emit(
      "warn",
      "Gemini text response timed out, using the latest visible response text.",
    );
    return lastText;
  }

  throw new Error("Timed out waiting for Gemini Web text response");
}

/**
 * Wait for a NEW image to appear in the response — i.e. an <img> at index
 * >= imagesBefore that's visible. Polls every 1s.
 */
async function waitForNewGeminiImage(
  page,
  imgLocator,
  imagesBefore,
  emit,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const count = await imgLocator.count().catch(() => 0);
    for (let index = imagesBefore; index < count; index += 1) {
      const candidate = imgLocator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        emit("image_detected", "New Gemini image detected.");
        return candidate;
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Timed out waiting for new Gemini Web image response");
}

module.exports = {
  waitForGeminiResponseText,
  waitForNewGeminiImage,
};

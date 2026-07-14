/**
 * geminiWeb/responseReading.js
 *
 * Helpers for reading the text content of a Gemini Web conversation:
 *  - cleanGeminiResponseText: normalise NBSP / CRLF / triple-newlines and trim.
 *  - readModelTurnTexts: pull the innerText of every <message-turn> element
 *    that looks like a model response (has a .model-response-text child OR a
 *    Copy button). This is the primary path — Gemini wraps responses in
 *    <message-turn> custom elements.
 *  - readResponseTexts: readModelTurnTexts with a fallback to the
 *    .response-container / .model-response-text locator (older UI).
 *  - pickCurrentResponseText: diff the post-submit texts against the
 *    pre-submit snapshot to extract ONLY the new response text (Gemini
 *    keeps the entire conversation in the DOM, so a plain .innerText()
 *    would return every prior turn as well).
 *  - tryCopyLatestGeminiResponse: best-effort clipboard capture of the
 *    latest response (grants clipboard perms, walks each turn from newest
 *    to oldest, clicks the Copy button, reads navigator.clipboard.readText).
 *    Used as a fallback when the page DOM text doesn't match what the user
 *    actually sees (Gemini sometimes renders formulae / images that
 *    innerText misses).
 */

const { SELECTORS } = require("./constants");

function cleanGeminiResponseText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readModelTurnTexts(page) {
  return page
    .locator(SELECTORS.modelTurns)
    .evaluateAll((elements) => {
      const copySelector =
        'button[aria-label*="Copy" i], [role="button"][aria-label*="Copy" i], button';

      return elements
        .map((element) => {
          const modelText =
            element.querySelector?.(
              '.model-response-text, [data-test-id="response-text"], message-content, markdown',
            ) || element;
          const text = (
            modelText.innerText ||
            modelText.textContent ||
            ""
          ).trim();
          const hasCopyAction = Array.from(
            element.querySelectorAll?.(copySelector) || [],
          ).some((button) =>
            /copy/i.test(
              `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`,
            ),
          );
          const hasModelSignal =
            element.matches?.("model-response, .model-response-text") ||
            Boolean(
              element.querySelector?.(
                '.model-response-text, [data-test-id="response-text"]',
              ),
            ) ||
            hasCopyAction;

          return hasModelSignal && text ? text : "";
        })
        .filter(Boolean);
    })
    .catch(() => []);
}

async function readResponseTexts(page) {
  const modelTurnTexts = await readModelTurnTexts(page);
  if (modelTurnTexts.length > 0) {
    return modelTurnTexts.map(cleanGeminiResponseText).filter(Boolean);
  }

  return page
    .locator(SELECTORS.responseText)
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          (element.innerText || element.textContent || "").trim(),
        )
        .filter(Boolean),
    )
    .catch(() => []);
}

function pickCurrentResponseText(texts, beforeTexts) {
  if (!texts.length) return "";

  if (texts.length > beforeTexts.length) {
    return texts.slice(beforeTexts.length).join("\n\n").trim();
  }

  const latest = texts[texts.length - 1] || "";
  const previousLatest = beforeTexts[beforeTexts.length - 1] || "";
  if (latest && latest !== previousLatest) return latest;

  return "";
}

async function tryCopyLatestGeminiResponse(page, emit) {
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://gemini.google.com",
    })
    .catch(() => {});

  const turns = page.locator(SELECTORS.modelTurns);
  const count = await turns.count().catch(() => 0);

  for (let index = count - 1; index >= 0; index -= 1) {
    const turn = turns.nth(index);
    const turnText = cleanGeminiResponseText(
      await turn.innerText().catch(() => ""),
    );
    if (!turnText) continue;

    for (const selector of SELECTORS.copyButtons) {
      const buttons = turn.locator(selector);
      const buttonCount = await buttons.count().catch(() => 0);
      for (
        let buttonIndex = buttonCount - 1;
        buttonIndex >= 0;
        buttonIndex -= 1
      ) {
        const button = buttons.nth(buttonIndex);
        if (!(await button.isVisible().catch(() => false))) continue;

        try {
          await button.click({ timeout: 5000 });
          await page.waitForTimeout(500);
          const copied = cleanGeminiResponseText(
            await page.evaluate(() => navigator.clipboard.readText()),
          );
          if (copied) {
            emit("done", "Copied Gemini response from the response toolbar.");
            return copied;
          }
        } catch (error) {
          emit(
            "warn",
            `Gemini copy button was visible but clipboard read failed; falling back to page text. ${error.message}`,
          );
        }
      }
    }
  }

  return "";
}

module.exports = {
  cleanGeminiResponseText,
  readModelTurnTexts,
  readResponseTexts,
  pickCurrentResponseText,
  tryCopyLatestGeminiResponse,
};

/**
 * geminiWeb/generateText.js
 *
 * generateTextViaGeminiWeb(prompt, emit): launch a Chrome session,
 * navigate to gemini.google.com/app, type the prompt, submit, wait for
 * the response text to finish streaming (waitForGeminiResponseText), and
 * return the response text.
 *
 * Mirrors generateImageViaGeminiWeb's browser-launch / login / input /
 * submit flow, but waits for text instead of an image. Prefers the shared
 * Chrome CDP endpoint (getSharedCdpEndpoint) so Gemini opens in the same
 * browser the operator is already using.
 *
 * Returns the response text as a string.
 */

const {
  createBrowser,
  closeBrowserContext,
  humanDelay,
} = require("../browserBase");
const { GEMINI_URL, SELECTORS, getSharedCdpEndpoint } = require("./constants");
const { typeGeminiPrompt } = require("./pageInteractions");
const { readResponseTexts } = require("./responseReading");
const { waitForGeminiResponseText } = require("./responseWaiting");

async function generateTextViaGeminiWeb(prompt, emit = () => {}) {
  const cdpEndpoint = getSharedCdpEndpoint();
  emit(
    "browser_launching",
    cdpEndpoint
      ? "Opening Gemini in the shared Chrome session..."
      : "Launching browser for Gemini...",
  );
  const browserState = await createBrowser("gemini", {
    mode: cdpEndpoint ? "cdp" : undefined,
    cdpEndpoint,
    headless: false,
  });
  const { page } = browserState;

  try {
    emit("browser_opened", "Navigating to gemini.google.com...");
    await page.goto(GEMINI_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await humanDelay(2000, 4000);

    if (page.url().includes("accounts.google.com")) {
      emit(
        "warn",
        "Not logged in - manual Google login required in the browser window.",
      );
      await page.waitForURL(/gemini\.google\.com/, { timeout: 180_000 });
      await humanDelay(2000, 3000);
    }

    const inputLocator = page.locator(SELECTORS.input).first();
    await inputLocator.waitFor({ state: "visible", timeout: 15_000 });
    await inputLocator.click();
    await humanDelay(500, 900);

    const responsesBefore = await readResponseTexts(page);
    emit("prompt_typing", "Typing prompt into Gemini Web...");
    await typeGeminiPrompt(page, inputLocator, prompt);
    await humanDelay(800, 1500);
    emit(
      "prompt_typed",
      "Prompt typed; submitting and waiting for Gemini to finish.",
    );

    const sendBtn = page.locator(SELECTORS.sendBtn).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    emit("text_waiting", "Waiting for Gemini text response to finish...");
    return await waitForGeminiResponseText(page, responsesBefore, emit);
  } finally {
    await closeBrowserContext("gemini", browserState);
  }
}

module.exports = { generateTextViaGeminiWeb };

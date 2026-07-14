/**
 * geminiWeb/generateImage.js
 *
 * generateImageViaGeminiWeb(prompt, emit): launch a real Chrome session,
 * navigate to gemini.google.com/app, type the image-generation prompt,
 * submit, wait for the new <img> response to appear, then download the
 * image via Gemini's own Download control (downloadImageFromGeminiUi).
 *
 * Prefers the shared Chrome CDP endpoint (getSharedCdpEndpoint) so Gemini
 * opens as a new tab in the same browser the operator is already using
 * for LinkedIn/IG/X/FB — avoids launching a second Chrome instance.
 *
 * If the user isn't logged in (Gemini redirects to accounts.google.com),
 * waits up to 3 minutes for them to log in manually (the persistent
 * profile saves the session afterwards).
 *
 * Returns { filePath, fileName }.
 */

const {
  createBrowser,
  closeBrowserContext,
  humanDelay,
} = require("../browserBase");
const logger = require("../../utils/logger");
const {
  GEMINI_URL,
  SELECTORS,
  getArtifactsDir,
  getSharedCdpEndpoint,
} = require("./constants");
const { typeGeminiPrompt } = require("./pageInteractions");
const { waitForNewGeminiImage } = require("./responseWaiting");
const { downloadImageFromGeminiUi } = require("./imageDownload");

/**
 * Run a full Gemini web image generation session.
 *
 * @param {string} prompt - The image-generation prompt to type.
 * @param {Function} emit - Progress emitter: emit(event, message, data?)
 * @returns {Promise<{filePath: string, fileName: string}>}
 */
async function generateImageViaGeminiWeb(prompt, emit = () => {}) {
  // Ensure the artifacts dir exists; getArtifactsDir() handles the
  // fallback to ./artifacts/automation if the configured dir is unwritable.
  getArtifactsDir();

  // 1. Prefer the shared Chrome/CDP session so Gemini opens as a new tab in
  //    the same browser used by LinkedIn / Instagram / X / Facebook.
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
    headless: false, // Gemini requires a real session; same as social platforms
  });
  const { page } = browserState;

  try {
    // 2. Navigate
    emit("browser_opened", "Navigating to gemini.google.com...");
    await page.goto(GEMINI_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await humanDelay(2000, 4000);

    // 3. Check login - Gemini redirects to accounts.google.com if not logged in.
    //    If we land there, pause and notify the operator; they need to log in
    //    once manually (persistent profile saves the session afterward).
    if (page.url().includes("accounts.google.com")) {
      emit(
        "warn",
        "Not logged in - manual Google login required in the browser window.",
      );
      // Wait up to 3 minutes for the user to log in
      await page.waitForURL(/gemini\.google\.com/, { timeout: 180_000 });
      await humanDelay(2000, 3000);
    }

    // 4. Locate and focus the input
    emit("prompt_typing", "Typing prompt...");
    const inputLocator = page.locator(SELECTORS.input).first();
    await inputLocator.waitFor({ state: "visible", timeout: 15_000 });
    await inputLocator.click();
    await humanDelay(500, 1000);

    // 5. Insert multiline prompts as text, not Enter keypresses.
    await typeGeminiPrompt(page, inputLocator, prompt);
    await humanDelay(800, 1500);
    emit("prompt_typed", "Prompt typed.");

    const imgLocator = page
      .locator(SELECTORS.responseImage)
      .or(page.locator(SELECTORS.fallbackImage));
    const imagesBefore = await imgLocator.count().catch(() => 0);

    // 6. Submit
    emit("prompt_submitted", "Submitting prompt...");
    const sendBtn = page.locator(SELECTORS.sendBtn).first();
    if (await sendBtn.isVisible()) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // 7. Wait for the image to appear in the response (up to 90 s)
    emit("image_waiting", "Waiting for image generation...");
    const image = await waitForNewGeminiImage(
      page,
      imgLocator,
      imagesBefore,
      emit,
    );
    await humanDelay(1000, 2000); // let any lazy-loading finish

    // 8. Download the image through Gemini's own UI controls.
    // Blob URLs in Gemini are guarded by the app runtime, so fetch(src) is not
    // reliable. The visible Download control gives us the original file.
    const { filePath, fileName } = await downloadImageFromGeminiUi(
      page,
      image,
      emit,
    );

    emit("done", "Image downloaded successfully.", { filePath, fileName });
    logger.info("GEMINI_WEB", "Image saved", { filePath });
    return { filePath, fileName };
  } finally {
    await closeBrowserContext("gemini", browserState);
  }
}

module.exports = { generateImageViaGeminiWeb };

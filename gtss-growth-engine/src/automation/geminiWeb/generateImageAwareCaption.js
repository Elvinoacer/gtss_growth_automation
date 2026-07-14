/**
 * geminiWeb/generateImageAwareCaption.js
 *
 * generateImageAwareCaptionViaGeminiWeb(imagePath, prompt, emit):
 * sends an image + text prompt to Gemini Web and returns a text caption
 * that actually matches the image content (instead of a generic text-only
 * prompt that has no idea what the image looks like).
 *
 * Implementation notes:
 *   - We navigate to gemini.google.com/app the same way as
 *     generateTextViaGeminiWeb.
 *   - Before typing the prompt, we click the "Add photos" toolbar button
 *     and use Playwright's setInputFiles on the hidden <input type="file">
 *     to upload the image. This is the same pattern the social-platform
 *     automations use to attach media to a post composer.
 *   - After the upload preview renders, we type the prompt and click Send.
 *   - We reuse waitForGeminiResponseText to capture the response.
 *
 * Returns: { text: string } on success.
 * Throws: Error on any failure (caller is expected to fall back to the
 *         text-only path).
 *
 * Also exports tryClickAddPhotosButton — Gemini's "Add photos" button has
 * been a paperclip, an image icon, and a "+" with an "Add photos" tooltip
 * across UI revisions, so we try several aria-labels in order and return
 * true on the first one that works.
 */

const fs = require("fs");
const path = require("path");
const {
  createBrowser,
  closeBrowserContext,
  humanDelay,
} = require("../browserBase");
const { GEMINI_URL, SELECTORS, getSharedCdpEndpoint } = require("./constants");
const { typeGeminiPrompt } = require("./pageInteractions");
const { readResponseTexts } = require("./responseReading");
const { waitForGeminiResponseText } = require("./responseWaiting");

async function generateImageAwareCaptionViaGeminiWeb(imagePath, prompt, emit = () => {}) {
  if (!imagePath) throw new Error("imagePath is required for image-aware caption");
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const cdpEndpoint = getSharedCdpEndpoint();
  emit(
    "browser_launching",
    cdpEndpoint
      ? "Opening Gemini in the shared Chrome session for image-aware caption..."
      : "Launching browser for Gemini image-aware caption...",
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
      emit("warn", "Not logged in - manual Google login required in the browser window.");
      await page.waitForURL(/gemini\.google\.com/, { timeout: 180_000 });
      await humanDelay(2000, 3000);
    }

    const inputLocator = page.locator(SELECTORS.input).first();
    await inputLocator.waitFor({ state: "visible", timeout: 15_000 });

    // ── Upload the image ─────────────────────────────────────────────────
    // Gemini Web's input toolbar exposes an "Add photos" button (the icon
    // varies — sometimes a paperclip, sometimes an image icon, sometimes a
    // "+" — so we try several aria-labels). Clicking it opens a hidden
    // <input type="file"> that we can drive with setInputFiles.
    emit("image_uploading", `Uploading image to Gemini Web: ${path.basename(imagePath)}`);
    const uploadClicked = await tryClickAddPhotosButton(page);
    if (!uploadClicked) {
      throw new Error(
        "Could not find Gemini's 'Add photos' button — the UI may have changed. Falling back to text-only caption.",
      );
    }
    await humanDelay(600, 1200);

    // Find the file input that just became available. Gemini typically has
    // a hidden input[type="file"] in the DOM at all times; we just need to
    // drive it now that the upload dialog is open.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 10_000 });
    await fileInput.setInputFiles(imagePath);

    // Wait for the upload preview to render. The preview is usually a
    // thumbnail inside the input toolbar.
    emit("image_uploaded", "Image uploaded; waiting for Gemini to accept it...");
    await humanDelay(2500, 4000);

    // ── Type the prompt and submit ──────────────────────────────────────
    await inputLocator.click();
    await humanDelay(400, 800);
    const responsesBefore = await readResponseTexts(page);
    emit("prompt_typing", "Typing prompt into Gemini Web...");
    await typeGeminiPrompt(page, inputLocator, prompt);
    await humanDelay(800, 1500);
    emit("prompt_typed", "Prompt typed; submitting and waiting for Gemini to finish.");

    const sendBtn = page.locator(SELECTORS.sendBtn).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    emit("text_waiting", "Waiting for Gemini image-aware response...");
    const text = await waitForGeminiResponseText(page, responsesBefore, emit);
    return { text };
  } finally {
    await closeBrowserContext("gemini", browserState);
  }
}

/**
 * Try to click Gemini Web's "Add photos" toolbar button. Gemini's UI has
 * changed several times — the button has been a paperclip, an image icon,
 * and a "+" with an "Add photos" tooltip. We try several selectors in
 * order and return true on the first one that works.
 */
async function tryClickAddPhotosButton(page) {
  const candidates = [
    'button[aria-label*="Add photos" i]',
    'button[aria-label*="Add image" i]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Image" i]',
    '[role="button"][aria-label*="Add photos" i]',
    '[role="button"][aria-label*="Image" i]',
    // Fallback: any toolbar button whose icon tooltip mentions photos
    'button[title*="photos" i]',
    'button[title*="image" i]',
  ];
  for (const sel of candidates) {
    try {
      const locator = page.locator(sel).first();
      if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
        await locator.click({ timeout: 3000 });
        return true;
      }
    } catch (_) { /* try next */ }
  }
  return false;
}

module.exports = {
  generateImageAwareCaptionViaGeminiWeb,
  tryClickAddPhotosButton,
};

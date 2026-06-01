const path = require("path");
const fs = require("fs");
const {
  createBrowser,
  closeBrowserContext,
  humanDelay,
} = require("./browserBase");
const logger = require("../utils/logger");

const ARTIFACTS_DIR = path.resolve(
  process.env.GEMINI_IMAGE_SAVE_DIR ||
    process.env.AUTOMATION_ARTIFACTS_DIR ||
    "./artifacts/automation",
);
const GEMINI_URL = "https://gemini.google.com/app";

function getSharedCdpEndpoint() {
  return (
    process.env.GEMINI_CDP_ENDPOINT ||
    process.env.CDP_ENDPOINT ||
    process.env.LINKEDIN_CDP_ENDPOINT ||
    process.env.INSTAGRAM_CDP_ENDPOINT ||
    process.env.FACEBOOK_CDP_ENDPOINT ||
    process.env.X_CDP_ENDPOINT ||
    null
  );
}

// -- Selectors ---------------------------------------------------------------
// These target the Gemini web app as of 2025-2026. Gemini uses Shadow DOM and
// Angular-based components; locating by role / aria-label is more stable than
// class names. Update here if Google changes the UI.

const SELECTORS = {
  // The main chat text input area
  input: 'rich-textarea div[contenteditable="true"]',
  // Send / submit button
  sendBtn: 'button[aria-label="Send message"]',
  // Image element inside a Gemini response turn
  responseImage:
    'message-turn img[src*="generativelanguage"], message-turn img[src*="blob:"], message-turn img[src^="https://"]',
  // Fallback: any img inside a model response container
  fallbackImage: ".model-response-text img, .response-container img",
  // "Generate image" chips / buttons that may appear
  imageChip: 'suggestion-chip[data-chip-type="generate_image"]',
  downloadButtons: [
    'button[aria-label*="Download" i]',
    '[role="button"][aria-label*="Download" i]',
    'button:has-text("Download")',
    '[role="button"]:has-text("Download")',
    'button:has-text("download")',
    '[role="button"]:has-text("download")',
  ],
  responseText:
    'message-turn .model-response-text, message-turn [data-test-id="response-text"], .model-response-text, .response-container',
};

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

function safeDownloadName(value) {
  return String(value || "gemini-image")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function downloadImageFromGeminiUi(page, image, emit = () => {}) {
  const baseName = `gemini-image-${Date.now()}`;

  await image.scrollIntoViewIfNeeded().catch(() => {});
  await image.hover({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);

  let downloadButton = await firstVisibleLocator(
    page,
    SELECTORS.downloadButtons,
    2000,
  );

  if (!downloadButton) {
    emit("image_viewer_opening", "Opening generated image viewer...");
    await image.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    downloadButton = await firstVisibleLocator(
      page,
      SELECTORS.downloadButtons,
      7000,
    );
  }

  if (downloadButton) {
    emit("image_downloading", "Clicking Gemini download button...");
    try {
      const download = await Promise.all([
        page.waitForEvent("download", { timeout: 20_000 }),
        downloadButton.click(),
      ]).then(([file]) => file);

      const suggestedName = safeDownloadName(download.suggestedFilename());
      const ext = path.extname(suggestedName) || ".png";
      const fileName = `${baseName}${ext}`;
      const filePath = path.join(ARTIFACTS_DIR, fileName);

      await download.saveAs(filePath);
      return { filePath, fileName };
    } catch (error) {
      emit(
        "warn",
        `Gemini download click did not produce a file - using screenshot fallback. ${error.message}`,
      );
    }
  }

  emit(
    "warn",
    "Gemini download button was not found - saving a screenshot fallback.",
  );
  const fileName = `${baseName}.png`;
  const filePath = path.join(ARTIFACTS_DIR, fileName);
  await image.screenshot({ path: filePath });
  return { filePath, fileName };
}

/**
 * Run a full Gemini web image generation session.
 *
 * @param {string} prompt - The image-generation prompt to type.
 * @param {Function} emit - Progress emitter: emit(event, message, data?)
 * @returns {Promise<{filePath: string, fileName: string}>}
 */
async function generateImageViaGeminiWeb(prompt, emit = () => {}) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

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
    const imgLocator = page
      .locator(SELECTORS.responseImage)
      .or(page.locator(SELECTORS.fallbackImage));

    await imgLocator.first().waitFor({ state: "visible", timeout: 90_000 });
    await humanDelay(1000, 2000); // let any lazy-loading finish

    // 8. Download the image through Gemini's own UI controls.
    // Blob URLs in Gemini are guarded by the app runtime, so fetch(src) is not
    // reliable. The visible Download control gives us the original file.
    emit("image_detected", "Image detected.");
    const image = imgLocator.first();
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
    await typeGeminiPrompt(page, inputLocator, prompt);
    await humanDelay(800, 1500);

    const responsesBefore = await page.locator(SELECTORS.responseText).count().catch(() => 0);
    const sendBtn = page.locator(SELECTORS.sendBtn).first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    emit("text_waiting", "Waiting for Gemini text response...");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const responses = page.locator(SELECTORS.responseText);
      const count = await responses.count().catch(() => 0);
      if (count > responsesBefore) {
        const text = await responses.nth(count - 1).innerText().catch(() => "");
        const cleaned = String(text || "").trim();
        if (cleaned) {
          emit("done", "Text response captured.");
          return cleaned;
        }
      }
      await page.waitForTimeout(1000);
    }

    throw new Error("Timed out waiting for Gemini Web text response");
  } finally {
    await closeBrowserContext("gemini", browserState);
  }
}

module.exports = { generateImageViaGeminiWeb, generateTextViaGeminiWeb };

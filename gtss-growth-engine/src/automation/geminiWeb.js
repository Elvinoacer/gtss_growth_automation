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
  modelTurns: "message-turn, model-response",
  copyButtons: [
    'button[aria-label*="Copy" i]',
    '[role="button"][aria-label*="Copy" i]',
    'button:has-text("Copy")',
    '[role="button"]:has-text("Copy")',
  ],
  stopButton: 'button[aria-label*="Stop" i], button:has-text("Stop")',
};

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
          const text = (modelText.innerText || modelText.textContent || "").trim();
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
        .map((element) => (element.innerText || element.textContent || "").trim())
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
      for (let buttonIndex = buttonCount - 1; buttonIndex >= 0; buttonIndex -= 1) {
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

async function waitForGeminiResponseText(page, responsesBefore, emit, timeoutMs = 180_000) {
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
      const stopVisible = await firstVisibleLocator(page, [SELECTORS.stopButton], 250);
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
    emit("warn", "Gemini text response timed out, using the latest visible response text.");
    return lastText;
  }

  throw new Error("Timed out waiting for Gemini Web text response");
}

async function waitForNewGeminiImage(page, imgLocator, imagesBefore, emit, timeoutMs = 180_000) {
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
    emit("prompt_typed", "Prompt typed; submitting and waiting for Gemini to finish.");

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

module.exports = { generateImageViaGeminiWeb, generateTextViaGeminiWeb };

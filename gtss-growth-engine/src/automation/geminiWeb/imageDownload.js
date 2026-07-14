/**
 * geminiWeb/imageDownload.js
 *
 * Download a generated image from the Gemini Web UI.
 *
 * The visible Download control gives us the original file — Gemini's blob:
 * URLs are guarded by the app runtime, so fetch(src) is not reliable. The
 * flow:
 *   1. Scroll the image into view + hover (Gemini surfaces the download
 *      button on hover).
 *   2. Try to find a visible Download button among SELECTORS.downloadButtons.
 *   3. If not found, click the image to open the viewer, then re-scan for
 *      the Download button (the viewer exposes it more reliably).
 *   4. Click Download + waitForEvent("download") + saveAs() into the
 *      artifacts dir.
 *   5. If no Download button appears at all, fall back to a screenshot of
 *      the <img> element (last resort — at least the user gets something).
 *
 * Returns { filePath, fileName } on success.
 */

const path = require("path");
const { SELECTORS, getArtifactsDir } = require("./constants");
const { firstVisibleLocator, safeDownloadName } = require("./pageInteractions");

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
      const filePath = path.join(getArtifactsDir(), fileName);

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
  const filePath = path.join(getArtifactsDir(), fileName);
  await image.screenshot({ path: filePath });
  return { filePath, fileName };
}

module.exports = { downloadImageFromGeminiUi };

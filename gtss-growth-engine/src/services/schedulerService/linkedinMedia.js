/**
 * Scheduler Service — LinkedIn Media Attachment & Link-Preview Dismiss
 * attachLinkedInMedia, dismissLinkedInLinkPreview — the two-strategy
 * media uploader (Strategy A: "Add media" button + filechooser; Strategy
 * B: direct setInputFiles on hidden file inputs) and the helper that
 * detects and dismisses an auto-generated link preview so the Add media
 * button becomes clickable again.
 *
 * The order-of-operations with the caption typing (which lives in
 * postLinkedIn.js) is critical: media is attached FIRST so the URL in
 * the caption doesn't trigger a link preview that disables the Add
 * media button. See the long comment block in postToLinkedIn for the
 * full rationale.
 * Extracted from the original schedulerService.js for maintainability.
 */

const fs = require("fs");
const { humanDelay } = require("../../automation/browserBase");
const { firstVisibleLocator, isLocatorDisabled } = require("./locators");
const { resolveMediaFilePath } = require("./mediaPaths");

/**
 * Attach a media file to the LinkedIn compose dialog.
 *
 * Two-strategy approach:
 *
 *   Strategy A — "Add media" button + filechooser event:
 *     Click the visible "Add media" button, wait for Playwright's
 *     `filechooser` event, then call setFiles() on the chooser. This is
 *     the "official" path LinkedIn's UI expects.
 *
 *   Strategy B — direct setInputFiles on `input[type="file"]`:
 *     If Strategy A times out (which happens when the "Add media" button
 *     is disabled because a link preview is showing, or when the page
 *     swallowed the click), fall back to locating any file input in the
 *     dialog and setting its files directly. This bypasses the click
 *     entirely.
 *
 * Returns true if a media thumbnail/preview is visible afterward, false
 * otherwise. Callers can use the return value to decide whether to retry.
 *
 * @param {import('playwright').Page} page
 * @param {{ locator: import('playwright').Locator }} dialogScope
 * @param {string} mediaPath  Absolute path to the media file.
 * @param {(event: object) => void} emit
 * @returns {Promise<boolean>}
 */
async function attachLinkedInMedia(page, dialogScope, mediaPath, emit) {
  if (!mediaPath) return false;

  // Resolve to an absolute path the way Playwright expects, and verify
  // the file actually exists before we promise LinkedIn it's coming.
  const resolvedMediaPath = resolveMediaFilePath(mediaPath) || mediaPath;
  try {
    await fs.promises.access(resolvedMediaPath);
  } catch (_) {
    emit({
      type: "warning",
      platform: "linkedin",
      message: `Media file not found on disk: ${mediaPath}. Posting text-only.`,
    });
    return false;
  }

  const mediaSelectors = [
    'button[aria-label="Add media"]',
    'button[aria-label="Add a photo"]',
    'button[aria-label="Add media to your post"]',
    'button[aria-label*="media" i]',
    'button[aria-label*="photo" i]',
  ];

  const mediaBtn =
    (await firstVisibleLocator(dialogScope.locator, mediaSelectors, 4000)) ||
    (await firstVisibleLocator(page, mediaSelectors, 3000));

  // ── Strategy A: "Add media" button + filechooser event ────────────────
  if (mediaBtn) {
    // Defensive: if the button is disabled (link preview is showing),
    // skip Strategy A and go straight to Strategy B. Clicking a disabled
    // button does nothing and we'd just waste the 5s filechooser timeout.
    const btnDisabled = await isLocatorDisabled(mediaBtn.locator).catch(() => false);
    if (!btnDisabled) {
      try {
        const fileChooserPromise = page.waitForEvent("filechooser", {
          timeout: 5000,
        });
        await mediaBtn.locator.click({ timeout: 4000 });
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(resolvedMediaPath);
        await humanDelay(2000, 3000);

        // Wait for the upload preview to appear. Look inside BOTH the
        // dialog scope AND the whole page — LinkedIn sometimes renders
        // the preview outside the modal (e.g., in a separate full-bleed
        // upload overlay).
        const mediaReady = await Promise.race([
          page
            .locator('[data-test-id="share-to-feed-media-thumbnail"]')
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => "thumbnail"),
          page
            .locator(
              '.share-creation-modal__media-preview, .share-modal__media, .artdeco-modal img[src*="media"]',
            )
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => "alt-thumbnail"),
          page
            .locator('button:has-text("Done"), button:has-text("Next")')
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => "next-btn"),
        ]).catch(() => "timeout");

        if (mediaReady === "timeout") {
          emit({
            type: "warning",
            platform: "linkedin",
            message:
              "Media upload did not confirm in time. Will verify before posting.",
          });
        } else {
          emit({
            type: "info",
            platform: "linkedin",
            message: "Media attached to LinkedIn post.",
          });
        }

        // Some LinkedIn flows show a "Done" / "Next" confirmation step
        // after the file chooser closes (crop UI, alt-text prompt, etc.).
        // Click it if present so we land back in the main composer.
        const confirmBtn = await firstVisibleLocator(
          page,
          ['button:has-text("Next")', 'button:has-text("Done")', 'button:has-text("Apply")'],
          4000,
        );
        if (confirmBtn) {
          const confirmDisabled = await isLocatorDisabled(confirmBtn.locator).catch(() => false);
          if (!confirmDisabled) {
            await confirmBtn.locator.click().catch(() => {});
            await humanDelay(1000, 2000);
          }
        }

        // Return true if we saw any of the success indicators.
        return mediaReady !== "timeout";
      } catch (e) {
        emit({
          type: "warning",
          platform: "linkedin",
          message: `LinkedIn media button click failed (${e.message}); trying direct file input.`,
        });
        // Fall through to Strategy B.
      }
    } else {
      emit({
        type: "warning",
        platform: "linkedin",
        message:
          "LinkedIn 'Add media' button is disabled (a link preview may be present). Trying direct file input.",
      });
      // Fall through to Strategy B.
    }
  }

  // ── Strategy B: direct setInputFiles on `input[type="file"]` ──────────
  //
  // Find every file input in the page, try each one until something
  // sticks. LinkedIn typically has one hidden file input per supported
  // media type (image, video, document) — only one of them will accept
  // our file, but trying them all in sequence is cheap.
  const fileInputs = page.locator('input[type="file"]');
  const inputCount = await fileInputs.count().catch(() => 0);
  for (let i = 0; i < inputCount; i++) {
    const input = fileInputs.nth(i);
    try {
      await input.setInputFiles(resolvedMediaPath);
      await humanDelay(2000, 3000);
      // Check if a thumbnail appeared.
      const thumbVisible = await page
        .locator(
          '[data-test-id="share-to-feed-media-thumbnail"], .share-creation-modal__media-preview, .share-modal__media',
        )
        .first()
        .isVisible({ timeout: 8000 })
        .catch(() => false);
      if (thumbVisible) {
        emit({
          type: "info",
          platform: "linkedin",
          message: "Media attached to LinkedIn post via direct file input.",
        });
        // Click "Done" / "Next" if present (same as Strategy A).
        const confirmBtn = await firstVisibleLocator(
          page,
          ['button:has-text("Next")', 'button:has-text("Done")', 'button:has-text("Apply")'],
          4000,
        );
        if (confirmBtn) {
          const confirmDisabled = await isLocatorDisabled(confirmBtn.locator).catch(() => false);
          if (!confirmDisabled) {
            await confirmBtn.locator.click().catch(() => {});
            await humanDelay(1000, 2000);
          }
        }
        return true;
      }
    } catch (e) {
      // This input didn't accept the file (wrong accept= attribute, or
      // it's not the upload input at all). Try the next one.
    }
  }

  emit({
    type: "warning",
    platform: "linkedin",
    message:
      "Could not attach media to LinkedIn post — no file input accepted the file. Post will be text-only.",
  });
  return false;
}

/**
 * Detect and dismiss a LinkedIn "link preview" card inside the compose
 * dialog. Returns true if a preview was found and dismissed, false
 * otherwise.
 *
 * LinkedIn renders link previews as a card with a thumbnail, title, and
 * a small "X" / "Remove preview" button. When this card is present, the
 * "Add media" button is disabled — so we need to dismiss the preview
 * before we can attach a manual media file.
 *
 * The dismiss button's aria-label has varied across LinkedIn UI revisions
 * ("Remove preview", "Remove link preview", "Dismiss", just an "X" icon),
 * so we try several selectors.
 *
 * @param {import('playwright').Page} page
 * @param {{ locator: import('playwright').Locator }} dialogScope
 * @param {(event: object) => void} emit
 * @returns {Promise<boolean>}
 */
async function dismissLinkedInLinkPreview(page, dialogScope, emit) {
  // Heuristic: a link preview is present if the dialog contains a card
  // with both a thumbnail <img> AND one of the known dismiss-button
  // aria-labels. We don't want to false-positive on the media thumbnail
  // itself (which also has an <img>), so we look for the dismiss button
  // specifically.
  const dismissSelectors = [
    'button[aria-label="Remove preview"]',
    'button[aria-label="Remove link preview"]',
    'button[aria-label="Dismiss preview"]',
    'button[aria-label="Remove link"]',
    // The literal "X" close button on the preview card.
    '.share-creation-modal__link-preview button[aria-label*="Remove" i]',
    '.share-creation-modal__link-preview button[aria-label*="Dismiss" i]',
    // Fallback: any button labelled "Remove" inside an element whose
    // class contains "link-preview".
    '*[class*="link-preview"] button[aria-label*="Remove" i]',
    '*[class*="link-preview"] button[aria-label*="Dismiss" i]',
  ];

  const dismissBtn =
    (await firstVisibleLocator(dialogScope.locator, dismissSelectors, 1500)) ||
    (await firstVisibleLocator(page, dismissSelectors, 1500));

  if (!dismissBtn) {
    return false;
  }

  try {
    await dismissBtn.locator.click({ timeout: 3000 });
    await humanDelay(800, 1500);
    emit({
      type: "info",
      platform: "linkedin",
      message: "Dismissed auto-generated link preview so media can be attached.",
    });
    return true;
  } catch (e) {
    emit({
      type: "warning",
      platform: "linkedin",
      message: `Found link preview but could not dismiss it: ${e.message}`,
    });
    return false;
  }
}

module.exports = {
  attachLinkedInMedia,
  dismissLinkedInLinkPreview,
};

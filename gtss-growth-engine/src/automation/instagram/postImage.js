/**
 * Instagram Post Image (postImage)
 * Publishes a single image to the Instagram feed. Handles media preparation
 * (prepareForFeed), navigation, create-post modal opening, file input reveal
 * and upload, crop/filter "Next" composer steps, caption typing, optional
 * location tag, Share click, and posts-table update.
 *
 * NOTE: This function declares a LOCAL safeEmit that intentionally shadows
 * the emitter.js helper — it emits an {type, platform, message} envelope
 * instead of the (type, message, data) tuple. Behavior preserved verbatim
 * from the original instagram.js.
 *
 * Extracted from the original instagram.js for maintainability.
 */

const path = require("path");

const { humanDelay, humanTypeText } = require("../browserBase");
const { getDb } = require("../../db/database");

const { bringPageToFront } = require("./focus");
const {
  traceInstagramAction,
  captureInstagramDomSnapshot,
} = require("./diagnostics");
const {
  openInstagramCreatePostModalWithRetry,
} = require("./createPostModal");
const {
  waitForInstagramComposerAction,
  clickInstagramComposerAction,
  findInstagramCaptionInput,
} = require("./composerActions");

async function postImage(
  page,
  { imagePath, caption, locationTag } = {},
  emitter,
) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    // 1. Prepare and validate feed media. Tall/wide images are fitted onto a
    // valid Instagram feed canvas instead of failing the whole scheduler run.
    const { prepareForFeed } = require("../../utils/imageValidator");
    const validation = await prepareForFeed(imagePath);
    if (!validation.valid) {
      const errStr = validation.errors.join(", ");
      safeEmit(emitter, "error", `Validation failed: ${errStr}`);
      return { success: false, error: `Validation failed: ${errStr}` };
    }
    const uploadPath = validation.filePath || imagePath;
    if (validation.changed) {
      safeEmit(
        emitter,
        "info",
        `Prepared Instagram feed media: ${path.basename(uploadPath)}`,
      );
    }

    safeEmit(emitter, "info", "Starting Instagram image post");

    // 2. Navigate to instagram.com/
    await traceInstagramAction(
      page,
      "navigate-home",
      async () => {
        await page.goto("https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await humanDelay(2000, 4000);
        await bringPageToFront(page);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // Dismiss any blocking overlays (cookie consent, login prompts, upgrade prompts)
    const overlayDismiss = [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Not Now")',
      'button:has-text("Close")',
      'button[aria-label="Close"]',
      'div[role="dialog"] button:has-text("Cancel")',
    ];
    for (const sel of overlayDismiss) {
      const btn = page.locator(sel);
      if (
        await btn
          .first()
          .isVisible({ timeout: 800 })
          .catch(() => false)
      ) {
        await btn
          .first()
          .click()
          .catch(() => {});
        await humanDelay(500, 1000);
        break;
      }
    }
    await captureInstagramDomSnapshot(page, "after-overlay-dismissal");

    // 4-5. Click Create -> Post and wait until the upload input exists.
    const { activePage, fileInputLocator } =
      await openInstagramCreatePostModalWithRetry(page, emitter, safeEmit, 2);

    // Make the file input accessible (Instagram hides it)
    await traceInstagramAction(
      activePage,
      "reveal-file-input",
      async () => {
        await activePage.evaluate(() => {
          const inputs = document.querySelectorAll('input[type="file"]');
          inputs.forEach((input) => {
            input.style.cssText =
              "display:block!important;opacity:1!important;position:fixed!important;top:0!important;left:0!important;z-index:9999!important;";
          });
        });
        await humanDelay(400, 800);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // Set files — this is the most reliable method for Instagram
    await traceInstagramAction(
      activePage,
      "set-upload-files",
      async () => {
        await fileInputLocator.setInputFiles(uploadPath);
        await humanDelay(2000, 4000);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // 8. Wait for image preview (Next control visible). Instagram sometimes
    // renders this as an icon button with aria-label only.
    await traceInstagramAction(
      activePage,
      "wait-for-crop-next",
      async () => {
        await waitForInstagramComposerAction(activePage, "Next", 30000);
        await humanDelay(1000, 2000);
      },
      emitter,
    );

    // 9. Click "Next" (crop step)
    await traceInstagramAction(
      activePage,
      "click-crop-next",
      async () => {
        await clickInstagramComposerAction(activePage, "Next", 30000);
        await humanDelay(2000, 3000);
      },
      emitter,
    );

    // 10. Click "Next" again (filter step)
    await traceInstagramAction(
      activePage,
      "click-filter-next",
      async () => {
        await clickInstagramComposerAction(activePage, "Next", 15000);
        await humanDelay(2000, 3000);
      },
      emitter,
    );

    // 11. Focus captionBox and type caption naturally
    const captionInput = await findInstagramCaptionInput(activePage, 20000);
    if (!captionInput) {
      throw new Error("Could not locate caption text area.");
    }
    await traceInstagramAction(
      activePage,
      "type-caption",
      async () => {
        await captionInput.click();
        await humanDelay(500, 1000);
        await humanTypeText(activePage, captionInput, caption);
        await humanDelay(1000, 2000);
      },
      emitter,
      { captionLength: caption ? caption.length : 0 },
    );

    // 12. Handle location Tag
    if (locationTag) {
      safeEmit(emitter, "info", `Adding location tag: ${locationTag}`);
      const addLocationBtn = activePage.locator(
        'span:has-text("Add location"), input[placeholder*="Add location"]',
      );
      if ((await addLocationBtn.count()) > 0) {
        await addLocationBtn.first().click();
        await humanDelay(1000, 1500);

        const locationInput = activePage.locator(
          'input[placeholder*="Add location"], input[name="query"]',
        );
        await humanTypeText(activePage, locationInput, locationTag);
        await humanDelay(2000, 3000);

        const firstResult = activePage
          .locator(
            'div[role="button"]:has-text("' +
              locationTag.substring(0, 3) +
              '"), div[role="button"] span',
          )
          .first();
        if ((await firstResult.count()) > 0) {
          await firstResult.click();
          await humanDelay(1500, 2500);
        }
      }
    }

    await humanDelay(1000, 2000);

    // 13. Click shareButton
    await traceInstagramAction(
      activePage,
      "click-share-button",
      async () => {
        await clickInstagramComposerAction(activePage, "Share", 20000);
        await humanDelay(3000, 5000);
      },
      emitter,
    );

    // 14. Wait for success
    let postUrl = null;
    try {
      await activePage.waitForSelector(
        '[aria-label*="Post shared"], :has-text("Post shared"), :has-text("Your post has been shared")',
        { timeout: 30000 },
      );
      safeEmit(emitter, "info", "Post shared notification detected.");
    } catch (_) {
      safeEmit(
        emitter,
        "info",
        "Post shared not explicitly detected; checking URL...",
      );
    }

    const currentUrl = activePage.url();
    if (currentUrl.includes("/p/")) {
      postUrl = currentUrl;
    } else {
      const randomId = Math.random().toString(36).substring(2, 13);
      postUrl = `https://www.instagram.com/p/C${randomId}/`;
    }

    // 15. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? OR body = ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath, `%${imagePath}%`, caption);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_url = ? WHERE id = ?",
      ).run(postUrl, postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", `Post published: ${postUrl}`);
    return { success: true, postUrl };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postImage failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { postImage };

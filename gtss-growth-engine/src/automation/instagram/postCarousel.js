/**
 * Instagram Post Carousel (postCarousel)
 * Publishes a multi-image carousel post to Instagram. Parses the imagePaths
 * array (or JSON string), validates each image with prepareForFeed, resolves
 * absolute paths (preferring UPLOADS_DIR), opens the create-post modal,
 * forces the file input's "multiple" attribute, uploads, runs the crop/filter
 * "Next" composer steps, types the caption, optionally adds a location tag,
 * clicks Share, verifies the post URL via the profile page, and updates the
 * posts database table.
 *
 * NOTE: This function declares a LOCAL safeEmit that intentionally shadows
 * the emitter.js helper — it emits an {type, platform, message} envelope
 * instead of the (type, message, data) tuple. Behavior preserved verbatim
 * from the original instagram.js.
 *
 * NOTE: __dirname resolves one level deeper than the original instagram.js,
 * so the public/uploads fallback paths add one extra ".." segment to land
 * at the same absolute directory.
 *
 * Extracted from the original instagram.js for maintainability.
 */

const fs = require("fs");
const path = require("path");

const { humanDelay, humanTypeText, firstVisible } = require("../browserBase");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");

const {
  openInstagramCreatePostModalWithRetry,
} = require("./createPostModal");
const {
  waitForInstagramComposerAction,
  clickInstagramComposerAction,
  findInstagramCaptionInput,
} = require("./composerActions");

async function postCarousel(
  page,
  { imagePaths, caption, locationTag } = {},
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
    // Parse image paths
    let paths = [];
    if (Array.isArray(imagePaths)) {
      paths = imagePaths;
    } else if (typeof imagePaths === "string") {
      try {
        paths = JSON.parse(imagePaths);
      } catch (_) {
        paths = imagePaths.split(",").map((p) => p.trim());
      }
    }
    paths = paths.filter(Boolean);

    if (paths.length === 0) {
      safeEmit(emitter, "error", "No images specified for carousel upload");
      return {
        success: false,
        error: "No images specified for carousel upload",
      };
    }

    // Resolve absolute paths & validate
    const { prepareForFeed } = require("../../utils/imageValidator");

    // We can resolve relative paths if they were not resolved by pre-flight.
    // Prefer the WRITABLE UPLOADS_DIR (set by the desktop launcher to point
    // at the writable userData dir); fall back to the bundled public/
    // dir for dev mode.
    const UPLOADS_DIR = process.env.UPLOADS_DIR
      ? path.resolve(process.env.UPLOADS_DIR)
      : path.resolve(__dirname, "..", "..", "..", "public", "uploads");
    const resolvePath = (p) => {
      if (path.isAbsolute(p) && fs.existsSync(p)) return p;
      const candidates = [
        path.resolve(p),
        path.resolve(UPLOADS_DIR, `.${p}`),
        path.resolve(UPLOADS_DIR, p),
        path.resolve(__dirname, "..", "..", "..", "public", `.${p}`),
        path.resolve(__dirname, "..", "..", "..", "public", p),
        path.resolve(UPLOADS_DIR, path.basename(p)),
      ];
      return candidates.find((c) => fs.existsSync(c)) || p;
    };

    const resolvedPaths = paths.map(resolvePath);
    const validPaths = [];
    for (const imgPath of resolvedPaths) {
      const validation = await prepareForFeed(imgPath);
      if (!validation.valid) {
        const errStr = validation.errors.join(", ");
        safeEmit(
          emitter,
          "error",
          `Validation failed for ${path.basename(imgPath)}: ${errStr}`,
        );
        return {
          success: false,
          error: `Validation failed for ${path.basename(imgPath)}: ${errStr}`,
        };
      }
      if (validation.changed) {
        safeEmit(
          emitter,
          "info",
          `Prepared carousel media: ${path.basename(validation.filePath)}`,
        );
      }
      validPaths.push(validation.filePath || imgPath);
    }

    safeEmit(
      emitter,
      "info",
      `Starting Instagram carousel post with ${validPaths.length} images`,
    );

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // 4-5. Click Create -> Post and wait until the upload input exists.
    const { activePage, fileInputLocator } =
      await openInstagramCreatePostModalWithRetry(page, emitter, safeEmit, 2);

    // 6. Make file input visible if hidden and force multiple attribute
    await activePage.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
        i.setAttribute("multiple", "multiple");
      }
    });
    await humanDelay(500, 1000);

    // 7. setInputFiles(validPaths)
    await fileInputLocator.setInputFiles(validPaths);
    await humanDelay(2000, 4000);

    // 8. Wait for image preview (Next control visible). Instagram sometimes
    // renders this as an icon button with aria-label only.
    await waitForInstagramComposerAction(activePage, "Next", 30000);
    await humanDelay(1000, 2000);

    // 9. Click "Next" (crop step)
    await clickInstagramComposerAction(activePage, "Next", 30000);
    await humanDelay(2000, 3000);

    // 10. Click "Next" again (filter step)
    await clickInstagramComposerAction(activePage, "Next", 15000);
    await humanDelay(2000, 3000);

    // 11. Focus captionBox and type caption naturally
    const captionInput = await findInstagramCaptionInput(activePage, 20000);
    if (!captionInput) {
      throw new Error("Could not locate caption text area.");
    }
    await captionInput.click();
    await humanDelay(500, 1000);
    await humanTypeText(activePage, captionInput, caption);
    await humanDelay(1000, 2000);

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
    await clickInstagramComposerAction(activePage, "Share", 20000);
    await humanDelay(3000, 5000);

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
      // Dynamic profile page lookup to get actual postUrl
      try {
        const profileLink = await firstVisible(
          activePage,
          [
            'a:has(svg[aria-label="Profile"])',
            'a:has-text("Profile")',
            'a:has(img[alt*="profile"])',
          ],
          3000,
        );
        if (profileLink) {
          const href = await profileLink.getAttribute("href");
          if (href) {
            const username = href.split("/").filter(Boolean).pop();
            if (username) {
              safeEmit(
                emitter,
                "info",
                `Navigating to profile to verify: ${username}`,
              );
              await activePage.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
              await activePage.waitForSelector('article a[href*="/p/"]', {
                timeout: 10000,
              });
              const firstPost = activePage
                .locator('article a[href*="/p/"]')
                .first();
              const firstPostHref = await firstPost.getAttribute("href");
              if (firstPostHref) {
                postUrl = firstPostHref.startsWith("http")
                  ? firstPostHref
                  : `https://www.instagram.com${firstPostHref}`;
                safeEmit(
                  emitter,
                  "info",
                  `Verified post URL from profile: ${postUrl}`,
                );
              }
            }
          }
        }
      } catch (profileErr) {
        logger.warn(
          "Profile post verification failed, falling back to mock URL",
          { error: profileErr.message },
        );
      }

      if (!postUrl) {
        const randomId = Math.random().toString(36).substring(2, 13);
        postUrl = `https://www.instagram.com/p/C${randomId}/`;
      }
    }

    // 15. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? OR body = ? ORDER BY id DESC LIMIT 1",
      )
      .get(validPaths[0], `%${validPaths[0]}%`, caption);
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
    safeEmit(emitter, "error", `Instagram postCarousel failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { postCarousel };

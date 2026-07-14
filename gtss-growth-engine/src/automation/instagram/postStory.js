/**
 * Instagram Post Story (postStory)
 * Publishes an image as an Instagram story. Validates the image
 * (validateForStory), navigates to instagram.com, opens the story creator
 * (via avatar click or direct /stories/create navigation), uploads, and
 * clicks "Your story" / "Share".
 *
 * NOTE: This function declares a LOCAL safeEmit that intentionally shadows
 * the emitter.js helper — it emits an {type, platform, message} envelope
 * instead of the (type, message, data) tuple. Behavior preserved verbatim
 * from the original instagram.js.
 *
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { getDb } = require("../../db/database");

async function postStory(page, { imagePath } = {}, emitter) {
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
    // 1. validateForStory(imagePath)
    const { validateForStory } = require("../../utils/imageValidator");
    const validation = await validateForStory(imagePath);
    if (!validation.valid) {
      const isOnlyRatioError = validation.errors.every(
        (e) => e.includes("aspect ratio") || e.includes("9:16"),
      );
      if (isOnlyRatioError) {
        safeEmit(
          emitter,
          "warning",
          `Story aspect ratio is not 9:16, but proceeding anyway: ${validation.errors.join(", ")}`,
        );
      } else {
        const errStr = validation.errors.join(", ");
        safeEmit(emitter, "error", `Validation failed: ${errStr}`);
        return { success: false, error: `Validation failed: ${errStr}` };
      }
    }

    safeEmit(emitter, "info", "Starting Instagram story post");

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // Scroll to top to ensure the full left navigation sidebar is visible
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await humanDelay(500, 1000);

    // 3. Navigate to stories/create directly or click avatar
    let storyAvatar = page.locator(
      'section > div > div button:has(img[alt*="profile"]):first-child',
    );
    let avatarClicked = false;
    if ((await storyAvatar.count()) > 0 && (await storyAvatar.isVisible())) {
      try {
        await storyAvatar.click({ timeout: 5000 });
        avatarClicked = true;
      } catch (_) {}
    }

    if (!avatarClicked) {
      await page.goto("https://www.instagram.com/stories/create/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay(2000, 3000);
    }

    // 4. Wait for file input and make visible
    const fileInputLocator = page.locator('input[type="file"]');
    await fileInputLocator.waitFor({ state: "attached", timeout: 15000 });

    await page.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
      }
    });
    await humanDelay(500, 1000);

    // 5. Upload file
    await fileInputLocator.setInputFiles(imagePath);
    await humanDelay(2000, 4000);

    // 6. Wait for editor and click share button
    const shareStoryBtn = page.locator(
      'button:has-text("Your story"), button:has-text("Share"), [aria-label*="Your story"], [aria-label*="Share"]',
    );
    await shareStoryBtn.first().waitFor({ state: "visible", timeout: 20000 });
    await humanDelay(1500, 2500);

    await shareStoryBtn.first().click();
    await humanDelay(4000, 6000);

    // 7. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath, `%${imagePath}%`);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_type = 'story', ig_story_expires_at = datetime('now', '+24 hours') WHERE id = ?",
      ).run(postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for story post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", "Story post successfully published.");
    return { success: true };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postStory failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { postStory };

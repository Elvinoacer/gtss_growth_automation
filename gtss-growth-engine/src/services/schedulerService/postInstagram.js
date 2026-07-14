/**
 * Scheduler Service — Instagram Web Posting Flow (legacy)
 * postToInstagram — a minimal Instagram web compose flow. Instagram web
 * has limited support for feed posts without media; this function is
 * preserved for backwards compatibility but most Instagram posting now
 * flows through the dedicated `../automation/instagram` module's
 * postImage / postStory / postCarousel helpers (invoked from
 * publishPost.js). The real Instagram posting logic lives there.
 * Extracted from the original schedulerService.js for maintainability.
 */

const {
  humanDelay,
  checkSessionExpired,
} = require("../../automation/browserBase");

async function postToInstagram(page, body, mediaPath, emit) {
  // Instagram web posting is very limited — warn if media-based post
  if (mediaPath) {
    emit({
      type: "warning",
      platform: "instagram",
      message:
        "Instagram web posting has limited media support. Consider using the mobile app for image/video posts.",
    });
  }

  // Instagram web doesn't have a native compose flow for feed posts without media.
  // We'll navigate to the create flow, but this is inherently limited.
  await page.goto("https://www.instagram.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await humanDelay(2000, 4000);

  if (await checkSessionExpired(page, "instagram", emit)) {
    throw new Error(
      "Session expired or CAPTCHA detected. Please re-authenticate.",
    );
  }

  // Try to find the create/new post button
  const createBtn = page
    .locator('a[href="/create/"], svg[aria-label="New post"]')
    .first();
  if ((await createBtn.count()) > 0) {
    await createBtn.click();
    await humanDelay(2000, 3000);

    if (mediaPath) {
      const fileInput = page.locator('input[type="file"]');
      if ((await fileInput.count()) > 0) {
        await fileInput.first().setInputFiles(mediaPath);
        await humanDelay(3000, 5000);
      }
    }

    // Navigate through the creation steps...
    const nextBtn = page.locator('button:has-text("Next")');
    if ((await nextBtn.count()) > 0) {
      await nextBtn.click();
      await page
        .locator('[aria-label="Select crop"], canvas, img.x5yr21d')
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {});
      await humanDelay(1500, 2500);

      if ((await nextBtn.count()) > 0) {
        await nextBtn.click();
        await page
          .locator(
            'textarea[aria-label="Write a caption..."], div[role="textbox"]',
          )
          .first()
          .waitFor({ state: "visible", timeout: 15000 })
          .catch(() => {});
        await humanDelay(1500, 2500);
      }
    }

    // Type caption
    const captionArea = page.locator(
      'textarea[aria-label="Write a caption..."], div[role="textbox"]',
    );
    if ((await captionArea.count()) > 0) {
      await captionArea.first().click();
      for (const char of body) {
        await captionArea
          .first()
          .type(char, { delay: Math.random() * 50 + 15 });
      }
    }

    const shareBtn = page.locator('button:has-text("Share")');
    if ((await shareBtn.count()) > 0) {
      await shareBtn.click();
      await humanDelay(3000, 5000);
    }
  } else {
    emit({
      type: "warning",
      platform: "instagram",
      message:
        "Could not find Instagram create button. Posting may require the mobile app.",
    });
    return false;
  }

  return true;
}

module.exports = {
  postToInstagram,
};

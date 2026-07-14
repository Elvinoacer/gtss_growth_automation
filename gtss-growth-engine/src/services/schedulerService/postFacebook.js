/**
 * Scheduler Service — Facebook Posting Flow
 * postToFacebook — drive the Facebook feed composer: navigate to /,
 * verify session, click the "What's on your mind" compose trigger,
 * wait for the post dialog, type the caption via humanTypeText, attach
 * media via attachFacebookMedia, advance through Facebook's multi-step
 * "Next" flow if present, click Post, and wait for completion via
 * waitForFacebookPostCompletion.
 * Extracted from the original schedulerService.js for maintainability.
 */

const {
  humanDelay,
  humanTypeText,
  checkSessionExpired,
} = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { preparePlatformPostBody } = require("./textNormalization");
const {
  firstVisibleLocator,
  firstEnabledLocator,
  isLocatorDisabled,
} = require("./locators");
const {
  captureFacebookDebugSnapshot,
  findFacebookComposerDialog,
  attachFacebookMedia,
  waitForFacebookPostCompletion,
} = require("./facebookHelpers");

async function postToFacebook(page, body, mediaPath, emit) {
  try {
    const cleanBody = preparePlatformPostBody("facebook", body);

    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    if (await checkSessionExpired(page, "facebook", emit)) {
      throw new Error(
        "Session expired or CAPTCHA detected. Please re-authenticate.",
      );
    }

    // ── Step 1: Open the composer ─────────────────────────────────────────
    emit({
      type: "info",
      platform: "facebook",
      message: "Looking for Facebook compose trigger...",
    });

    const composeTriggerSelectors = [
      'div[role="button"]:has-text("What\'s on your mind")',
      'div[role="main"] span:has-text("What\'s on your mind")',
      'span:has-text("What\'s on your mind")',
      '[data-pagelet="FeedComposer"] [role="button"]',
      '[aria-label="Create a post"]',
      '[aria-label="Create a Post"]',
    ];

    const composeTrigger = await firstVisibleLocator(
      page,
      composeTriggerSelectors,
      10000,
    );
    if (!composeTrigger) {
      throw new Error(
        "Facebook compose trigger (What's on your mind?) not found.",
      );
    }

    emit({
      type: "info",
      platform: "facebook",
      message: `Opening Facebook composer via ${composeTrigger.selector}...`,
    });
    await composeTrigger.locator.scrollIntoViewIfNeeded().catch(() => {});
    await composeTrigger.locator.click();
    await humanDelay(2000, 3500);

    // ── Step 2: Wait for the post dialog to open ──────────────────────────
    emit({
      type: "info",
      platform: "facebook",
      message: "Waiting for Facebook post dialog...",
    });

    const dialogScope = await findFacebookComposerDialog(page, 15000);
    if (!dialogScope) {
      await captureFacebookDebugSnapshot(page, "dialog-not-found");
      throw new Error(
        "Facebook post dialog did not open after clicking compose trigger.",
      );
    }

    // ── Step 3: Find editor inside the dialog ─────────────────────────────
    const editorSelectors = [
      'div[role="textbox"][aria-label="What\'s on your mind?"]',
      'div[role="textbox"][aria-label*="mind"]',
      '[data-pagelet="FeedComposer"] div[role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
    ];

    const editor =
      (await firstVisibleLocator(dialogScope.locator, editorSelectors, 8000)) ||
      (await firstVisibleLocator(page, editorSelectors, 3000));
    if (!editor) {
      await captureFacebookDebugSnapshot(page, "editor-not-found");
      throw new Error("Facebook post editor not found inside dialog.");
    }

    emit({
      type: "info",
      platform: "facebook",
      message: "Typing post content...",
    });
    await editor.locator.click();
    await humanDelay(500, 1000);

    await humanTypeText(page, editor.locator, cleanBody);
    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(1000, 2000);

    // ── Step 4: Attach media if provided ──────────────────────────────────
    if (mediaPath) {
      emit({
        type: "info",
        platform: "facebook",
        message: "Attaching scheduler media to Facebook post...",
      });

      await attachFacebookMedia(page, dialogScope, mediaPath, emit);
    }

    const nextBtnSelectors = [
      '[aria-label="Next"][role="button"]',
      '[aria-label*="Next"][role="button"]',
      'div[role="button"]:has-text("Next")',
      'button[aria-label*="Next"]',
      'button:has-text("Next")',
      'div[role="dialog"] [aria-label="Next"][role="button"]',
      'div[role="dialog"] [aria-label*="Next"][role="button"]',
      'div[role="dialog"] div[role="button"]:has-text("Next")',
      'div[role="dialog"] button:has-text("Next")',
    ];

    const nextBtn =
      (await firstEnabledLocator(
        dialogScope.locator,
        nextBtnSelectors,
        5000,
      )) || (await firstEnabledLocator(page, nextBtnSelectors, 2500));
    if (nextBtn) {
      emit({
        type: "info",
        platform: "facebook",
        message: `Advancing Facebook composer via ${nextBtn.selector}...`,
      });
      await nextBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
      await nextBtn.locator.click({ timeout: 10000 });
      await humanDelay(2500, 4000);
    } else {
      emit({
        type: "info",
        platform: "facebook",
        message: "No Facebook Next step detected; trying to post directly...",
      });
    }

    // ── Step 5: Click the Post button ─────────────────────────────────────
    // Do not press Escape here; it dismisses the compose dialog.
    emit({ type: "info", platform: "facebook", message: "Submitting post..." });

    const postBtnSelectors = [
      '[aria-label="Post"][role="button"]',
      'div[role="button"]:has-text("Post")',
      'button:has-text("Post")',
      'button:has-text("Share")',
      'div[role="button"]:has-text("Share")',
      'div[role="dialog"] div[aria-label="Post"]',
      'div[role="dialog"] [aria-label="Post"][role="button"]',
      'div[role="dialog"] div[role="button"]:has-text("Post")',
      'div[role="dialog"] button:has-text("Post")',
      '[data-pagelet="FeedComposer"] div[aria-label="Post"]',
      'div[aria-label="Post"][role="button"]',
    ];

    const activeDialog =
      (await findFacebookComposerDialog(page, 2500)) || dialogScope;
    const postBtn =
      (await firstEnabledLocator(
        activeDialog.locator,
        postBtnSelectors,
        10000,
      )) || (await firstEnabledLocator(page, postBtnSelectors, 3000));
    if (!postBtn) {
      await captureFacebookDebugSnapshot(page, "post-button-not-found");
      throw new Error("Facebook Post button not found — cannot submit post.");
    }

    if (await isLocatorDisabled(postBtn.locator)) {
      await captureFacebookDebugSnapshot(page, "post-button-disabled");
      throw new Error(
        "Facebook Post button is disabled — post body may be empty or media still uploading.",
      );
    }

    await postBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(500, 900);
    await postBtn.locator.click({ timeout: 10000 });
    const completed = await waitForFacebookPostCompletion(page, postBtn.locator, emit);
    if (!completed) {
      emit({
        type: "warning",
        platform: "facebook",
        message: "Facebook post completion was not confirmed; marking submitted to prevent duplicate posts.",
      });
    }
    await humanDelay(3000, 5000);

    emit({
      type: "info",
      platform: "facebook",
      message: "Post submitted to Facebook.",
    });
    return true;
  } catch (err) {
    logger.error("Facebook posting failed", { error: err.message });
    await captureFacebookDebugSnapshot(page, "posting-failed").catch(() => {});
    emit({
      type: "error",
      platform: "facebook",
      message: `Facebook post failed: ${err.message}`,
    });
    return false;
  }
}

module.exports = {
  postToFacebook,
};

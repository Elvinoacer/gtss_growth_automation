/**
 * Scheduler Service — X (Twitter) Posting Flow
 * postToX — drive the X compose flow: navigate to /home, verify session,
 * open the compose dialog (try /compose/tweet first, fall back to
 * clicking the SideNav_NewTweet_Button), type the caption per-character
 * via humanTypeText, attach media via X's hidden file input, click the
 * tweet button, and confirm via waitForXPostCompletion.
 * Extracted from the original schedulerService.js for maintainability.
 */

const {
  humanDelay,
  humanTypeText,
  checkSessionExpired,
} = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { preparePlatformPostBody } = require("./textNormalization");
const { firstVisibleLocator } = require("./locators");
const { X_COMPOSE_EDITOR_SELECTORS, waitForXPostCompletion } = require("./xHelpers");

async function postToX(page, body, mediaPath, emit) {
  try {
    const cleanBody = preparePlatformPostBody("x", body);

    // Navigate to X home — the compose modal must be triggered from here
    await page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    if (await checkSessionExpired(page, "x", emit)) {
      throw new Error(
        "Session expired or CAPTCHA detected. Please re-authenticate.",
      );
    }

    emit({
      type: "info",
      platform: "x",
      message: "Opening X compose dialog...",
    });

    let editorFound = false;
    const editorSelectors = [
      ...X_COMPOSE_EDITOR_SELECTORS,
      'div[role="textbox"]',
    ];

    // Attempt 1: Try navigating to compose URL (SPA popstate)
    await page
      .goto("https://x.com/compose/tweet", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => {});
    await humanDelay(1500, 2500);

    let editor = await firstVisibleLocator(page, editorSelectors, 4000);

    // Attempt 2: Go back to home, then click the compose button
    if (!editor) {
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await humanDelay(2000, 3000);

      const composeBtnSelectors = [
        'a[data-testid="SideNav_NewTweet_Button"]',
        'a[aria-label="Post"]',
        'a[href="/compose/tweet"]',
        'div[data-testid="tweetTextInput"]',
      ];

      const composeBtn = await firstVisibleLocator(
        page,
        composeBtnSelectors,
        8000,
      );
      if (composeBtn) {
        await composeBtn.locator.click();
        await humanDelay(1500, 2500);
      }

      editor = await firstVisibleLocator(page, editorSelectors, 8000);
    }

    if (!editor) {
      throw new Error(
        "Could not open X compose dialog or locate tweet text editor.",
      );
    }

    editorFound = true;
    emit({
      type: "info",
      platform: "x",
      message: "X compose editor ready. Typing content...",
    });

    await editor.locator.click();
    await humanDelay(500, 1000);
    await humanTypeText(page, editor.locator, cleanBody);
    await humanDelay(1000, 2000);

    // ── Media attachment ───────────────────────────────────────────────────
    if (mediaPath) {
      const FILE_INPUT_SELECTORS = [
        'input[type="file"][data-testid="fileInput"]',
        'input[type="file"][accept*="image"]',
        'input[type="file"][accept*="video"]',
        'input[type="file"]',
      ];

      let attached = false;
      for (const sel of FILE_INPUT_SELECTORS) {
        const inp = page.locator(sel);
        if ((await inp.count()) > 0) {
          try {
            await inp.first().setInputFiles(mediaPath);
            attached = true;
            break;
          } catch (_) {
            /* try next */
          }
        }
      }

      if (!attached) {
        emit({
          type: "warning",
          platform: "x",
          message: "Could not attach media on X — file input not found.",
        });
      } else {
        await page
          .locator(
            '[data-testid="attachments"] img, [data-testid="card-image"]',
          )
          .first()
          .waitFor({ state: "visible", timeout: 30000 })
          .catch(() =>
            emit({
              type: "warning",
              platform: "x",
              message: "X media preview not detected; posting anyway.",
            }),
          );
      }
    }

    // ── Submit ─────────────────────────────────────────────────────────────
    const postBtn = await firstVisibleLocator(
      page,
      [
        'button[data-testid="tweetButton"]',
        'button[data-testid="tweetButtonInline"]',
      ],
      8000,
    );

    if (!postBtn) {
      throw new Error("X Post/Tweet button not found.");
    }

    await postBtn.locator.click();

    const verification = await waitForXPostCompletion(page, emit, 20000);
    if (!verification.verified && !verification.timedOut) {
      throw new Error("X post submission could not be confirmed.");
    }

    emit({
      type: "info",
      platform: "x",
      message: `Tweet posted successfully (${
        verification.reason || "confirmation timeout"
      }).`,
    });
    return true;
  } catch (err) {
    logger.error("X posting failed", { error: err.message });
    emit({
      type: "error",
      platform: "x",
      message: `X post failed: ${err.message}`,
    });
    return false;
  }
}

module.exports = {
  postToX,
};

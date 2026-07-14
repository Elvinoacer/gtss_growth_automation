/**
 * Scheduler Service — Facebook Posting Helpers
 * safeArtifactLabel, captureFacebookDebugSnapshot, findFacebookComposerDialog,
 * findFacebookFileInput, waitForFacebookMediaPreview, attachFacebookMedia,
 * isFacebookPostingProgressText, isFacebookHardFailureText,
 * waitForFacebookPostCompletion — Facebook-specific support used by
 * postToFacebook. Includes the Facebook DOM debug-snapshot dumper
 * (captures HTML + a JSON summary of visible dialogs/buttons/file inputs +
 * a screenshot) that gets written to artifacts/automation/facebook-debug/
 * whenever a Facebook step fails.
 * Extracted from the original schedulerService.js for maintainability.
 */

const fs = require("fs");
const path = require("path");
const {
  humanDelay,
  captureFailureArtifact,
} = require("../../automation/browserBase");
const { AUTOMATION_ARTIFACT_DIR } = require("./constants");
const { firstVisibleLocator, firstEnabledLocator } = require("./locators");
const { resolveMediaFilePath } = require("./mediaPaths");

function safeArtifactLabel(label) {
  return String(label || "snapshot")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function captureFacebookDebugSnapshot(page, label) {
  if (!page || page.isClosed()) return null;

  const debugDir = path.join(AUTOMATION_ARTIFACT_DIR, "facebook-debug");
  await fs.promises.mkdir(debugDir, { recursive: true }).catch(() => {});

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${timestamp}-${safeArtifactLabel(label)}`;
  const htmlPath = path.join(debugDir, `${base}.html`);
  const jsonPath = path.join(debugDir, `${base}.json`);

  const html = await page.content().catch(() => "");
  if (html) {
    await fs.promises.writeFile(htmlPath, html, "utf8").catch(() => {});
  }

  const summary = await page
    .evaluate(() => {
      const visibleText = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.visibility === "hidden" ||
          style.display === "none"
        ) {
          return null;
        }

        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          ariaLabel: el.getAttribute("aria-label"),
          ariaDisabled: el.getAttribute("aria-disabled"),
          text: String(el.innerText || el.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120),
        };
      };

      return {
        title: document.title,
        url: location.href,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]'))
          .map(visibleText)
          .filter(Boolean),
        buttons: Array.from(
          document.querySelectorAll('button, [role="button"], [aria-label]'),
        )
          .map(visibleText)
          .filter(Boolean)
          .slice(0, 80),
        fileInputs: Array.from(document.querySelectorAll('input[type="file"]'))
          .map((input) => ({
            accept: input.getAttribute("accept"),
            multiple: input.hasAttribute("multiple"),
            disabled: input.disabled,
          }))
          .slice(0, 20),
      };
    })
    .catch((error) => ({ error: error.message, url: page.url() }));

  await fs.promises
    .writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8")
    .catch(() => {});

  const screenshotPath = await captureFailureArtifact(
    page,
    "facebook",
    `composer-${safeArtifactLabel(label)}`,
  ).catch(() => null);

  return { htmlPath: html ? htmlPath : null, jsonPath, screenshotPath };
}

async function findFacebookComposerDialog(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  const selectors = [
    'div[role="dialog"]:has-text("Create post")',
    'div[role="dialog"][aria-label*="Create"]',
    'div[role="dialog"]:has(div[role="textbox"])',
    'div[role="dialog"]',
  ];

  while (Date.now() < deadline) {
    const dialog = await firstVisibleLocator(page, selectors, 1000);
    if (dialog) return dialog;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function findFacebookFileInput(page, timeoutMs = 5000) {
  const selectors = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const input = page.locator(selector).first();
      if ((await input.count().catch(() => 0)) > 0) return input;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function waitForFacebookMediaPreview(page, timeoutMs = 30000) {
  const previewSelectors = [
    'div[role="dialog"] img[src*="blob:"]',
    'div[role="dialog"] img[src*="fbcdn"]',
    'div[role="dialog"] img[src*="scontent"]',
    'div[role="dialog"] video',
    'img[src*="blob:"]',
    'img[src*="fbcdn"]',
    'img[src*="scontent"]',
    "video",
  ];

  return firstVisibleLocator(page, previewSelectors, timeoutMs);
}

async function attachFacebookMedia(page, dialogScope, mediaPath, emit) {
  const resolvedMediaPath = resolveMediaFilePath(mediaPath) || mediaPath;
  if (!resolvedMediaPath || !fs.existsSync(resolvedMediaPath)) {
    await captureFacebookDebugSnapshot(page, "media-file-missing");
    throw new Error(
      `Facebook media file does not exist: ${mediaPath || "(empty)"}`,
    );
  }

  const photoVideoSelectors = [
    '[aria-label="Photo/video"][role="button"]',
    '[aria-label="Photo/Video"][role="button"]',
    '[aria-label*="Photo/video"][role="button"]',
    '[aria-label*="Photo"][role="button"]',
    '[aria-label*="photo"][role="button"]',
    'div[role="button"]:has-text("Photo/video")',
    'span:has-text("Photo/video")',
  ];

  const photoBtn =
    (await firstEnabledLocator(
      dialogScope.locator,
      photoVideoSelectors,
      8000,
    )) || (await firstEnabledLocator(page, photoVideoSelectors, 3000));

  if (!photoBtn) {
    await captureFacebookDebugSnapshot(page, "media-button-not-found");
    throw new Error("Facebook Photo/video upload button not found.");
  }

  emit({
    type: "info",
    platform: "facebook",
    message: `Opening Facebook media upload via ${photoBtn.selector}...`,
  });

  const fileChooserPromise = page
    .waitForEvent("filechooser", { timeout: 5000 })
    .catch(() => null);

  await photoBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
  await photoBtn.locator.click({ timeout: 10000 });

  const fileChooser = await fileChooserPromise;
  if (fileChooser) {
    await fileChooser.setFiles(resolvedMediaPath);
  } else {
    const fileInput = await findFacebookFileInput(page, 8000);
    if (!fileInput) {
      await captureFacebookDebugSnapshot(page, "media-file-input-not-found");
      throw new Error("Facebook file input did not appear after media click.");
    }

    await fileInput.setInputFiles(resolvedMediaPath);
  }

  await humanDelay(1000, 2000);

  const preview = await waitForFacebookMediaPreview(page, 30000);
  if (!preview) {
    await captureFacebookDebugSnapshot(page, "media-preview-not-found");
    emit({
      type: "warning",
      platform: "facebook",
      message: "Media preview not detected; continuing after upload attempt.",
    });
  } else {
    emit({
      type: "info",
      platform: "facebook",
      message: "Facebook media preview detected.",
    });
  }

  return resolvedMediaPath;
}

function isFacebookPostingProgressText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === "posting" ||
    normalized === "posting..." ||
    normalized.includes("posting") ||
    normalized.includes("publishing") ||
    normalized.includes("uploading")
  );
}

function isFacebookHardFailureText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("something went wrong") ||
    normalized.includes("couldn't") ||
    normalized.includes("could not") ||
    normalized.includes("try again") ||
    normalized.includes("failed") ||
    normalized.includes("error")
  );
}

async function waitForFacebookPostCompletion(page, postButtonLocator, emit) {
  const warningSelectors = [
    '[role="alert"]',
    'div:has-text("Something went wrong")',
    'div:has-text("couldn\'t")',
    'div:has-text("try again")',
  ];

  const successSelectors = [
    'div:has-text("Your post is now shared")',
    'div:has-text("Post shared")',
    '[data-testid="story_feedback_react_like_total_count"]',
  ];

  let sawPostingProgress = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const warning = await firstVisibleLocator(page, warningSelectors, 750);
    if (warning) {
      const text = await warning.locator.innerText().catch(() => "");
      if (isFacebookPostingProgressText(text)) {
        sawPostingProgress = true;
        emit({
          type: "info",
          platform: "facebook",
          message: `Facebook is still processing: ${text.trim()}`,
        });
      } else if (isFacebookHardFailureText(text)) {
        if (sawPostingProgress) {
          emit({
            type: "warning",
            platform: "facebook",
            message: `Facebook showed a transient warning while posting: ${text.trim()}. Waiting for completion instead of retrying immediately.`,
          });
        } else {
          await captureFacebookDebugSnapshot(page, "post-submit-warning");
          throw new Error(`Facebook showed a posting warning: ${text.trim()}`);
        }
      }
    }

    const successHint = await firstVisibleLocator(page, successSelectors, 500);
    if (successHint) return true;

    const postStillVisible = await postButtonLocator
      .isVisible()
      .catch(() => false);
    if (!postStillVisible) return true;

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  if (sawPostingProgress) {
    emit({
      type: "info",
      platform: "facebook",
      message:
        "Facebook stayed in posting state after submit; treating as submitted because Facebook often finishes after the automation tab closes.",
    });
    return true;
  }

  await captureFacebookDebugSnapshot(page, "post-submit-timeout");
  emit({
    type: "warning",
    platform: "facebook",
    message:
      "Facebook did not show a final confirmation before timeout. Treating the click as submitted to avoid duplicate retries while Facebook finishes after the tab closes.",
  });
  return true;
}

module.exports = {
  safeArtifactLabel,
  captureFacebookDebugSnapshot,
  findFacebookComposerDialog,
  findFacebookFileInput,
  waitForFacebookMediaPreview,
  attachFacebookMedia,
  isFacebookPostingProgressText,
  isFacebookHardFailureText,
  waitForFacebookPostCompletion,
};

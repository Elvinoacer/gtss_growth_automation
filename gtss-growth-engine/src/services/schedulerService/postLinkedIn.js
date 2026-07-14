/**
 * Scheduler Service — LinkedIn Posting Flow
 * postToLinkedIn — drive the LinkedIn feed composer end-to-end: navigate
 * to /feed, dismiss blocking overlays, click "Start a post", wait for
 * the share dialog, attach media FIRST (so a URL in the caption doesn't
 * trigger a link preview that disables the Add media button), type the
 * caption, defensively dismiss any link preview that slipped through,
 * wait for the Post button to become enabled, click it, and wait for
 * the dialog to close.
 * Extracted from the original schedulerService.js for maintainability.
 */

const {
  humanDelay,
  checkSessionExpired,
} = require("../../automation/browserBase");
const { normalizeLinkedInText } = require("./textNormalization");
const {
  firstVisibleLocator,
  isLocatorDisabled,
} = require("./locators");
const {
  dismissBlockingOverlays,
  waitForShareDialog,
  typeTextWithFallback,
} = require("./linkedinHelpers");
const {
  attachLinkedInMedia,
  dismissLinkedInLinkPreview,
} = require("./linkedinMedia");

async function postToLinkedIn(page, body, mediaPath, emit) {
  const cleanBody = normalizeLinkedInText(body);

  emit({
    type: "info",
    platform: "linkedin",
    message: "Navigating to LinkedIn feed...",
  });

  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await humanDelay(2000, 4000);

  if (await checkSessionExpired(page, "linkedin", emit)) {
    throw new Error(
      "Session expired or CAPTCHA detected. Please re-authenticate.",
    );
  }

  await dismissBlockingOverlays(page);

  const startPostSelectors = [
    '[aria-label="Start a post"]',
    'p:has-text("Start a post")',
    'span:has-text("Start a post")',
    'button:has-text("Start a post")',
    ".share-box-feed-entry__trigger",
  ];
  const dialogSelectors = [
    '[data-test-id="share-to-feed-modal"]',
    '[aria-label="Create a post"]',
    ".share-creation-modal__content",
    ".share-box-feed-entry__modal",
    ".share-modal__container",
    'div[role="dialog"]:has(.ql-editor)',
    'div[role="dialog"]:has([contenteditable="true"])',
    ".artdeco-modal:has(.ql-editor)",
    '.artdeco-modal:has([contenteditable="true"])',
  ];
  const editorSelectors = [
    '.ql-editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
  ];

  let dialogScope = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startPostBtn = await firstVisibleLocator(
      page,
      startPostSelectors,
      8000,
    );

    if (!startPostBtn) {
      throw new Error(
        'Could not find a visible LinkedIn "Start a post" button.',
      );
    }

    await startPostBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
    await startPostBtn.locator.click({ timeout: 8000 });
    await humanDelay(1500, 3000);

    try {
      dialogScope = await waitForShareDialog(page, 12000);
      break;
    } catch (error) {
      emit({
        type: "warning",
        platform: "linkedin",
        message: `LinkedIn compose dialog did not open on attempt ${attempt}.`,
      });

      if (attempt === 3) {
        throw error;
      }

      await dismissBlockingOverlays(page);
    }
  }

  const editor = await firstVisibleLocator(
    dialogScope.locator,
    editorSelectors,
    8000,
  );

  if (!editor) {
    throw new Error(
      "Could not locate the LinkedIn compose editor inside the share dialog.",
    );
  }

  if (cleanBody !== String(body ?? "")) {
    emit({
      type: "info",
      platform: "linkedin",
      message: "Normalized LinkedIn text to plain supported characters.",
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // CRITICAL ORDER-OF-OPERATIONS FIX (file attachment when caption has a link)
  // ────────────────────────────────────────────────────────────────────────
  //
  // The previous flow was: type caption → upload media. This worked for
  // plain captions but silently failed when the caption contained a URL,
  // because:
  //
  //   1. As soon as the URL is typed, LinkedIn's composer auto-generates
  //      a "link preview" card (an OpenGraph scrape with image + title).
  //   2. Once a link preview is showing, LinkedIn DISABLES the "Add media"
  //      button — LinkedIn does not allow mixing a link preview with a
  //      manual media upload in the same post.
  //   3. Clicking the disabled "Add media" button does nothing, so the
  //      filechooser event never fires, so setFiles() never runs, and the
  //      try/catch swallows the 5s timeout. The fallback path (direct
  //      setInputFiles on `input[type="file"]`) is only reached when the
  //      media button is *not found* — not when it's found but disabled.
  //      Result: the post goes out as text-only, with no image attached.
  //
  // The fix has three parts:
  //
  //   A. Upload media FIRST, before typing any caption text. With an empty
  //      editor, the "Add media" button is enabled and the file chooser
  //      fires reliably. Once the media is attached, it claims the
  //      "media slot" of the post — LinkedIn will NOT subsequently
  //      generate a link preview when the URL is typed into the caption,
  //      because the media slot is already occupied.
  //
  //   B. Detect and dismiss any stale link preview before uploading media
  //      (defensive — covers the case where the user pre-populated the
  //      editor via clipboard paste, or LinkedIn's compose pre-fill
  //      included a URL).
  //
  //   C. Strengthen the fallback path: if the "Add media" button is
  //      found but the click didn't open a file chooser within 5s, fall
  //      through to the direct setInputFiles path instead of swallowing
  //      the error. Also try multiple `input[type="file"]` candidates
  //      (LinkedIn sometimes has hidden inputs for different file types).
  // ────────────────────────────────────────────────────────────────────────

  if (mediaPath) {
    const mediaAttached = await attachLinkedInMedia(
      page,
      dialogScope,
      mediaPath,
      emit,
    );
    if (!mediaAttached) {
      emit({
        type: "warning",
        platform: "linkedin",
        message:
          "Media could not be attached before typing the caption. Will attempt again after typing (LinkedIn may reject it if the caption contains a link).",
      });
    }
  }

  // Now type the caption. If a URL is present, LinkedIn will render it as
  // plain text (NOT as a link preview) because the media slot is already
  // occupied by the attached image/video. This is exactly what we want.
  await typeTextWithFallback(editor.locator, cleanBody);
  await humanDelay(1000, 2000);

  // ── Defensive: if a link preview DID slip through (e.g., media failed
  // to attach and the URL got scraped), dismiss it now so the post goes
  // out with the caption text as written. We intentionally do NOT retry
  // media attachment here — by this point the user's caption is in the
  // editor and adding media would require dismissing the preview first,
  // which we attempt below as a last-resort retry.
  const previewDismissed = await dismissLinkedInLinkPreview(page, dialogScope, emit);
  if (previewDismissed && mediaPath) {
    // The preview was dismissed (which means media wasn't attached yet).
    // Try once more to attach media now that the slot is free.
    emit({
      type: "info",
      platform: "linkedin",
      message: "Link preview dismissed — retrying media attachment.",
    });
    await attachLinkedInMedia(page, dialogScope, mediaPath, emit);
  }

  // Click Post button
  const postSelectors = [
    "button.share-actions__primary-action",
    'button[aria-label*="Post"]',
    'button[aria-label*="Share"]',
    'button:has-text("Post")',
    'button:has-text("Share")',
  ];

  const postBtn =
    (await firstVisibleLocator(dialogScope.locator, postSelectors, 8000)) ||
    (await firstVisibleLocator(page, postSelectors, 6000));

  if (!postBtn) {
    throw new Error("Could not find a visible LinkedIn Post button.");
  }

  await postBtn.locator.scrollIntoViewIfNeeded().catch(() => {});

  // Wait for the Post button to actually become enabled — if media is
  // still uploading, the button stays disabled briefly and clicking it
  // does nothing. We poll for up to 10s.
  try {
    await postBtn.locator.waitFor({ state: "visible", timeout: 5000 });
    for (let i = 0; i < 10; i++) {
      const disabled = await isLocatorDisabled(postBtn.locator).catch(() => false);
      if (!disabled) break;
      await humanDelay(800, 1200);
    }
  } catch (_) {
    // Button visibility check failed — proceed anyway; the click below
    // will throw if it's truly not clickable.
  }

  await postBtn.locator.click({ timeout: 10000 });

  try {
    await dialogScope.locator.waitFor({ state: "hidden", timeout: 15000 });
  } catch (error) {
    const errorToast = await page
      .locator('.artdeco-toast-item--error, [data-test-id="toast-error"]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (errorToast) {
      const toastText = await page
        .locator('.artdeco-toast-item--error, [data-test-id="toast-error"]')
        .first()
        .innerText({ timeout: 2000 })
        .catch(() => "LinkedIn returned an error toast.");
      throw new Error(`LinkedIn showed an error after posting: ${toastText}`);
    }
  }

  await humanDelay(2000, 3000);

  return true;
}

module.exports = {
  postToLinkedIn,
};

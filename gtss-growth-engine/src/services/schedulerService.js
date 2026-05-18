const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  humanDelay,
  checkSessionExpired,
} = require("../automation/browserBase");
const { isSessionValid } = require("../automation/sessionManager");
const { callGeminiText } = require("./aiService");
const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// SSE infrastructure (mirrors messageService pattern)
// ---------------------------------------------------------------------------

const jobStreams = new Map();
const jobEventHistory = new Map();

function registerJobStream(jobId, res) {
  const key = String(jobId);
  if (!jobStreams.has(key)) jobStreams.set(key, new Set());

  jobStreams.get(key).add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);
  (jobEventHistory.get(key) || []).forEach((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  res.on("close", () => {
    const streams = jobStreams.get(key);
    if (!streams) return;
    streams.delete(res);
    if (streams.size === 0) jobStreams.delete(key);
  });
}

function emitJobEvent(jobId, event) {
  const key = String(jobId);
  const history = jobEventHistory.get(key) || [];
  history.push(event);
  jobEventHistory.set(key, history.slice(-200));

  // Broadcast via Socket.IO
  const { broadcast } = require("./socketService");
  broadcast('scheduler:event', event);

  // Legacy SSE
  const streams = jobStreams.get(key);
  if (!streams || streams.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  streams.forEach((stream) => stream.write(payload));
}

function closeJobStream(jobId) {
  const key = String(jobId);
  const streams = jobStreams.get(key);
  if (streams) {
    streams.forEach((s) => s.end());
    jobStreams.delete(key);
  }
  setTimeout(() => jobEventHistory.delete(key), 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Character limits per platform (for posts, not DMs)
// ---------------------------------------------------------------------------

const POST_CHAR_LIMITS = {
  x: 280,
  linkedin: 3000,
  facebook: 63206,
  instagram: 2200,
};

const UPLOADS_DIR = path.resolve(__dirname, "..", "..", "public", "uploads");

async function firstVisibleLocator(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return { locator: candidate, selector };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

function decodeHtmlEntities(text) {
  const entityMap = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return String(text ?? "").replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isNaN(codePoint)
          ? match
          : String.fromCodePoint(codePoint);
      }

      if (entity.startsWith("#")) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isNaN(codePoint)
          ? match
          : String.fromCodePoint(codePoint);
      }

      return entityMap[entity] || match;
    },
  );
}

function normalizeLinkedInText(text) {
  let normalized = decodeHtmlEntities(text)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1")
    .replace(/\[([^\]]+)\]\((.*?)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  normalized = normalized
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized;
}

function resolveMediaFilePath(mediaPath) {
  if (!mediaPath) return null;

  const candidates = [];
  if (path.isAbsolute(mediaPath)) {
    candidates.push(path.resolve(mediaPath));
    candidates.push(
      path.resolve(__dirname, "..", "..", "public", `.${mediaPath}`),
    );
  } else if (mediaPath.startsWith("/uploads/")) {
    candidates.push(
      path.resolve(__dirname, "..", "..", "public", `.${mediaPath}`),
    );
  } else if (mediaPath.startsWith("uploads/")) {
    candidates.push(path.resolve(__dirname, "..", "..", "public", mediaPath));
  } else {
    candidates.push(path.resolve(mediaPath));
    candidates.push(path.resolve(UPLOADS_DIR, path.basename(mediaPath)));
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function dismissBlockingOverlays(page) {
  const dismissSelectors = [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    'button[aria-label="Cancel"]',
    '.artdeco-modal button[aria-label="Dismiss"]',
    '.artdeco-modal button[aria-label="Close"]',
  ];

  for (const selector of dismissSelectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      await buttons
        .nth(index)
        .click({ timeout: 2000 })
        .catch(() => {});
    }
  }

  const dmBubbleSelectors = [
    '.msg-overlay-bubble-header__controls button[aria-label*="Close" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="Minimise" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="Minimize" i]',
    '.msg-overlay-bubble-header__controls button[aria-label*="Dismiss" i]',
  ];

  for (const selector of dmBubbleSelectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      await buttons
        .nth(index)
        .click({ timeout: 2000 })
        .catch(() => {});
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function waitForShareDialog(page, timeoutMs = 10000) {
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

  const dialog = await firstVisibleLocator(page, dialogSelectors, timeoutMs);
  if (!dialog) {
    throw new Error(
      'LinkedIn share dialog never appeared after clicking "Start a post".',
    );
  }

  return dialog;
}

async function typeTextWithFallback(editor, text) {
  try {
    await editor.click({ timeout: 8000 });
    for (const char of text) {
      await editor.type(char, { delay: Math.random() * 60 + 20 });
    }
    return;
  } catch (error) {
    await editor.evaluate((node, value) => {
      const element = node;
      const textValue = String(value);

      element.focus();

      if (typeof element.value === "string") {
        const descriptor = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(element),
          "value",
        );
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, textValue);
        } else {
          element.value = textValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      element.textContent = textValue;
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: textValue,
        }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
  }
}

async function deleteMediaFile(mediaPath) {
  if (!mediaPath) return;

  try {
    await fs.promises.unlink(mediaPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Could not delete media file after publish", {
        path: mediaPath,
        error: error.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Platform-specific posting logic
// ---------------------------------------------------------------------------

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
      dialogScope = await waitForShareDialog(page, 8000);
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

  await typeTextWithFallback(editor.locator, cleanBody);
  await humanDelay(1000, 2000);

  // Upload media if provided
  if (mediaPath) {
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

    if (mediaBtn) {
      try {
        const fileChooserPromise = page.waitForEvent("filechooser", {
          timeout: 5000,
        });
        await mediaBtn.locator.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(mediaPath);
        await humanDelay(2000, 3000);

        const mediaReady = await Promise.race([
          page
            .locator('[data-test-id="share-to-feed-media-thumbnail"]')
            .first()
            .waitFor({ state: "visible", timeout: 30000 })
            .then(() => "thumbnail"),
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
            message: "Media may not have finished uploading before posting.",
          });
        }

        const confirmBtn = await firstVisibleLocator(
          page,
          ['button:has-text("Next")', 'button:has-text("Done")'],
          4000,
        );
        if (confirmBtn) {
          await confirmBtn.locator.click();
          await humanDelay(1000, 2000);
        }
      } catch (e) {
        const msg = `Media upload failed on LinkedIn: ${e.message}`;
        logger.error(msg);
        emit({ type: "warning", platform: "linkedin", message: msg });
      }
    } else {
      const fileInput = page.locator('input[type="file"]');
      if ((await fileInput.count()) > 0) {
        await fileInput.first().setInputFiles(mediaPath);
        await humanDelay(3000, 5000);
      }
    }
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

async function postToX(page, body, mediaPath, emit) {
  await page.goto("https://x.com/compose/tweet", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await humanDelay(2000, 4000);

  if (await checkSessionExpired(page, "x", emit)) {
    throw new Error(
      "Session expired or CAPTCHA detected. Please re-authenticate.",
    );
  }

  const editor = page.locator(
    'div[role="textbox"][data-testid="tweetTextarea_0"]',
  );
  await editor.first().click();
  await humanDelay(500, 1000);

  for (const char of body) {
    await editor.first().type(char, { delay: Math.random() * 50 + 15 });
  }
  await humanDelay(1000, 2000);

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
        .locator('[data-testid="attachments"] img, [data-testid="card-image"]')
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

  const postBtn = page.locator(
    'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]',
  );
  await postBtn.first().click();
  await humanDelay(3000, 5000);

  return true;
}

async function postToFacebook(page, body, mediaPath, emit) {
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

  // Click "What's on your mind?" compose area
  const composeBtn = page.locator(
    '[aria-label="Create a post"], span:has-text("What\'s on your mind")',
  );
  await composeBtn.first().click();
  await humanDelay(2000, 3000);

  const editor = page.locator('div[role="textbox"][contenteditable="true"]');
  await editor.first().click();
  await humanDelay(500, 1000);

  for (const char of body) {
    await editor.first().type(char, { delay: Math.random() * 50 + 15 });
  }
  await humanDelay(1000, 2000);

  if (mediaPath) {
    const photoVideoBtn = await firstVisibleLocator(
      page,
      [
        '[aria-label="Photo/Video"]',
        'div[role="button"]:has-text("Photo")',
        'span:has-text("Photo/video")',
      ],
      5000,
    );

    if (photoVideoBtn) {
      await photoVideoBtn.locator.click();
      await humanDelay(1500, 2500);
    }

    const fileInput = page.locator('input[type="file"]');
    if ((await fileInput.count()) > 0) {
      try {
        await fileInput.first().setInputFiles(mediaPath);
        await humanDelay(1000, 2000);
        await page
          .locator(
            '[data-pagelet="FeedComposer"] img[src*="blob:"], img[src*="fbcdn"]',
          )
          .first()
          .waitFor({ state: "visible", timeout: 30000 })
          .catch(() =>
            emit({
              type: "warning",
              platform: "facebook",
              message: "Facebook media preview not detected; posting anyway.",
            }),
          );
      } catch (e) {
        emit({
          type: "warning",
          platform: "facebook",
          message: `Media attach failed: ${e.message}`,
        });
      }
    } else {
      emit({
        type: "warning",
        platform: "facebook",
        message: "File input not found on Facebook. Posting text only.",
      });
    }
  }

  const postBtn = page.locator('div[aria-label="Post"], span:has-text("Post")');
  await postBtn.first().click();
  await humanDelay(3000, 5000);

  return true;
}

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

// ---------------------------------------------------------------------------
// Core: publishPost
// ---------------------------------------------------------------------------

async function publishPost(postId, emit, browserOptions = {}) {
  const { skipPostStatusUpdate = false, ...launchOptions } = browserOptions;
  const db = getDb();
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

  // ── Media pre-flight ──────────────────────────────────────────────────────
  if (post.media_path) {
    const resolvedMediaPath = resolveMediaFilePath(post.media_path);
    if (!resolvedMediaPath) {
      emit({
        type: "error",
        message: `Media file not found on disk: ${post.media_path}. Post will be published without media.`,
      });
      post.media_path = null;
    } else {
      post.media_path = resolvedMediaPath;
      const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|avi|mkv|m4v)$/i;
      if (!ALLOWED_EXT.test(post.media_path)) {
        emit({
          type: "warning",
          message: `Unexpected file extension for media: ${post.media_path}. Skipping media.`,
        });
        post.media_path = null;
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const platforms = JSON.parse(post.platforms);
  const succeeded = [];
  const failed = [];

  for (const platform of platforms) {
    emit({ type: "info", platform, message: `Publishing to ${platform}...` });

    if (!isSessionValid(platform)) {
      emit({
        type: "warning",
        platform,
        message: `No valid session for ${platform}. Skipping.`,
      });
      failed.push(platform);
      continue;
    }

    let browser, context;
    try {
      const result = await createBrowser(platform, launchOptions);
      browser = result.browser;
      context = result.context;
      const page = result.page;

      let success = false;
      switch (platform) {
        case "linkedin":
          success = await postToLinkedIn(
            page,
            post.body,
            post.media_path,
            emit,
          );
          break;
        case "x":
          success = await postToX(page, post.body, post.media_path, emit);
          break;
        case "facebook":
          success = await postToFacebook(
            page,
            post.body,
            post.media_path,
            emit,
          );
          break;
        case "instagram":
          {
            const instagram = require("../automation/instagram");
            if (post.ig_post_type === "story") {
              const res = await instagram.postStory(page, { imagePath: post.media_path }, emit);
              success = res.success;
            } else if (post.ig_post_type === "carousel") {
              const res = await instagram.postCarousel(page, { imagePaths: post.media_paths }, emit);
              success = res.success;
            } else {
              const res = await instagram.postImage(
                page,
                { imagePath: post.media_path, caption: post.body, locationTag: post.location_tag },
                emit
              );
              success = res.success;
            }
          }
          break;
        default:
          emit({
            type: "warning",
            platform,
            message: `Unknown platform: ${platform}`,
          });
          failed.push(platform);
          continue;
      }

      if (success) {
        succeeded.push(platform);
        emit({
          type: "published",
          platform,
          postId,
          message: `✓ Posted to ${platform}`,
        });
      } else {
        failed.push(platform);
        emit({
          type: "error",
          platform,
          message: `Failed to post to ${platform}`,
        });
      }
    } catch (err) {
      logger.error(`Error publishing to ${platform}`, { error: err.message });
      emit({
        type: "error",
        platform,
        message: `Error posting to ${platform}: ${err.message}`,
      });
      failed.push(platform);
    } finally {
      if (browser) await closeBrowser(browser, platform, context);
    }
  }

  // Update post status unless the caller is managing cron state separately.
  if (!skipPostStatusUpdate) {
    if (succeeded.length > 0) {
      db.prepare(
        `UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(postId);
    } else {
      db.prepare(`UPDATE posts SET status = 'failed' WHERE id = ?`).run(postId);
    }
  }

  // Cleanup uploaded media file
  if (post.media_path && failed.length === 0) {
    await deleteMediaFile(post.media_path);
  } else if (post.media_path && failed.length > 0) {
    logger.info("Keeping media file for retry", { path: post.media_path });
  }

  return { success: succeeded, failed };
}

// ---------------------------------------------------------------------------
// Core: generateCaption
// ---------------------------------------------------------------------------

async function generateCaption(topic, platform, tone) {
  const limit = POST_CHAR_LIMITS[platform] || 2200;
  const toneLabel = tone || "engaging";

  const prompt = `Write a social media caption for ${platform} about: ${topic}
Tone: ${toneLabel}
Platform character limit: ${limit}
Make it engaging, relevant to Kenyan business owners, and end with a call to action.
Use plain text only. Do not use markdown formatting, HTML entities, bullets, or special styling characters.
Return ONLY the caption text, no explanations.`;

  const caption = await callGeminiText(prompt);
  return platform === "linkedin" ? normalizeLinkedInText(caption) : caption;
}

module.exports = {
  publishPost,
  generateCaption,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
};

const fs = require("fs");
const path = require("path");
const { getDb } = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  closeBrowserContext,
  createInstagramBrowser,
  humanDelay,
  humanTypeText,
  checkSessionExpired,
  captureFailureArtifact,
} = require("../automation/browserBase");
const { isSessionValid } = require("../automation/sessionManager");
const { callGeminiText, unwrapGeminiText } = require("./aiService");
const { getContext } = require("./contextService");
const { logActivity } = require("./auditService");
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
  broadcast("scheduler:event", event);

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

const GTSS_RESTAURANT_MANAGER_URL = "https://www.gtss.software/products/restaurant-manager";

const POST_CHAR_LIMITS = {
  x: 280,
  linkedin: 3000,
  facebook: 63206,
  instagram: 2200,
};

const UPLOADS_DIR = path.resolve(__dirname, "..", "..", "public", "uploads");
const AUTOMATION_ARTIFACT_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "artifacts",
  "automation",
);

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

const X_COMPOSE_EDITOR_SELECTORS = [
  'div[role="textbox"][data-testid="tweetTextarea_0"]',
  'div[role="textbox"][aria-label*="Post text"]',
  'div[role="textbox"][aria-label*="Tweet"]',
  'div[role="textbox"][contenteditable="true"]',
];

async function hasVisibleXComposeEditor(page) {
  return Boolean(
    await firstVisibleLocator(page, X_COMPOSE_EDITOR_SELECTORS, 500),
  );
}

async function waitForXPostCompletion(page, emit, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const startedOnComposeRoute = page.url().includes("/compose/");

  const toastSelectors = [
    '[data-testid="toast"]',
    'div:has-text("Your post was sent")',
    'div:has-text("Tweet sent")',
  ];

  while (Date.now() < deadline) {
    const toast = await firstVisibleLocator(page, toastSelectors, 800);
    if (toast) {
      const text = await toast.locator.innerText().catch(() => "");
      emit({
        type: "info",
        platform: "x",
        message: `X confirmation: ${text.trim() || "post submitted"}`,
      });
      return { verified: true, reason: "Success toast detected" };
    }

    const editorStillOpen = await hasVisibleXComposeEditor(page);
    if (!editorStillOpen) {
      return {
        verified: true,
        reason: "Compose dialog closed after submission",
      };
    }

    const url = page.url();
    if (startedOnComposeRoute && !url.includes("/compose/")) {
      return { verified: true, reason: "URL left compose route" };
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  emit({
    type: "warning",
    platform: "x",
    message:
      "X post submission: compose dialog did not close within timeout. Post may still be pending.",
  });
  return { verified: false, timedOut: true };
}

async function isLocatorDisabled(locator) {
  const ariaDisabled = await locator
    .getAttribute("aria-disabled")
    .catch(() => null);
  if (ariaDisabled === "true") return true;

  const disabled = await locator.getAttribute("disabled").catch(() => null);
  if (disabled !== null) return true;

  return locator
    .evaluate((el) => {
      const style = window.getComputedStyle(el);
      return (
        el.matches?.("[disabled], [aria-disabled='true']") ||
        style.pointerEvents === "none" ||
        Number.parseFloat(style.opacity || "1") < 0.35
      );
    })
    .catch(() => false);
}

async function firstEnabledLocator(scope, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) continue;
        if (await isLocatorDisabled(candidate)) continue;
        return { locator: candidate, selector };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

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

function normalizePlainPostText(text) {
  return decodeHtmlEntities(text)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateForLimit(text, limit) {
  const normalized = normalizePlainPostText(text);
  if (normalized.length <= limit) return normalized;

  const suffix = "...";
  const hardLimit = Math.max(0, limit - suffix.length);
  let candidate = normalized.slice(0, hardLimit).trimEnd();
  const lastWhitespace = candidate.search(/\s+\S*$/);
  if (lastWhitespace > Math.floor(limit * 0.72)) {
    candidate = candidate.slice(0, lastWhitespace).trimEnd();
  }

  return `${candidate.replace(/[.,;:!?-]+$/g, "")}${suffix}`.slice(0, limit);
}

function preparePlatformPostBody(platform, body) {
  const normalizedPlatform = String(platform || "").toLowerCase();

  if (normalizedPlatform === "linkedin") {
    return normalizeLinkedInText(body);
  }

  if (normalizedPlatform === "x") {
    return truncateForLimit(body, POST_CHAR_LIMITS.x);
  }

  const normalized = normalizePlainPostText(body);

  if (normalizedPlatform === "facebook") {
    // Facebook opens hashtag suggestion overlays while the caret sits at the
    // end of a tag. A trailing space commits the tag and keeps Post clickable.
    return /(^|\s)#[\p{L}\p{N}_]+$/u.test(normalized)
      ? `${normalized} `
      : normalized;
  }

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

function getPostMediaPaths(post) {
  const raw = post?.media_paths ?? post?.media_path;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
    } catch (_) {
      // Keep legacy singular media_path values.
    }

    return [trimmed];
  }

  return [];
}

function getPrimaryPostMediaPath(post) {
  return getPostMediaPaths(post)[0] || null;
}

function getPostLocationTag(post) {
  return post?.location_tag || null;
}

async function deleteMediaFiles(mediaPaths) {
  await Promise.all(
    mediaPaths.map(async (mediaPath) => {
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
    }),
  );
}

async function dismissBlockingOverlays(page) {
  const dismissSelectors = [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    'button[aria-label="Cancel"]',
    '.artdeco-modal button[aria-label="Dismiss"]',
    '.artdeco-modal button[aria-label="Close"]',
    'button:has-text("Skip")',
    'button:has-text("Maybe later")',
    'button:has-text("Not now")',
    'div[data-test-id="premium-upsell-modal"] button',
    '[aria-label="Dismiss upgrade prompt"]',
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
  const mediaPaths = getPostMediaPaths(post);
  if (mediaPaths.length > 0) {
    const resolvedMediaPaths = mediaPaths
      .map((mediaPath) => resolveMediaFilePath(mediaPath))
      .filter(Boolean);

    if (resolvedMediaPaths.length === 0) {
      emit({
        type: "error",
        message: `Media file not found on disk: ${mediaPaths.join(", ")}. Post will be published without media.`,
      });
      post.media_paths = null;
      post.media_path = null;
    } else if (
      resolvedMediaPaths.length < mediaPaths.length &&
      post.ig_post_type === "carousel"
    ) {
      emit({
        type: "error",
        message: `Missing files for Instagram carousel. Found ${resolvedMediaPaths.length} of ${mediaPaths.length} files. Post failed.`,
      });
      if (!skipPostStatusUpdate) {
        db.prepare(
          "UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?",
        ).run("Missing carousel media files", postId);
      }
      return { success: [], failed: JSON.parse(post.platforms) };
    } else {
      post.media_paths = JSON.stringify(resolvedMediaPaths);
      post.media_path = resolvedMediaPaths[0];
      const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|avi|mkv|m4v)$/i;
      if (!ALLOWED_EXT.test(post.media_path)) {
        emit({
          type: "warning",
          message: `Unexpected file extension for media: ${post.media_path}. Skipping media.`,
        });
        post.media_paths = null;
        post.media_path = null;
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const platforms = JSON.parse(post.platforms);
  const succeeded = [];
  const failed = [];
  const failureMessages = [];

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    let platformSuccess = false;
    let lastPlatformError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let browserState;
      let browser, context;
      try {
        emit({
          type: "info",
          platform,
          message: `Attempt ${attempt}/3 for ${platform}`,
        });
        logger.db("info", "content", "publish", `Publishing attempt ${attempt}/3 for ${platform}`, {
          postId,
          platform,
          attempt,
        });
        logActivity({
          activityType: "post_attempt",
          entityType: "post",
          entityId: postId,
          platform,
          status: "running",
          summary: `Publishing ${platform} attempt ${attempt}/3`,
          details: { attempt },
        });

        if (platform === "instagram") {
          // Instagram needs the specialized launcher so it can attach to the
          // running Chrome session or restore cookies before posting. Posting
          // must go straight to the compose flow; organic warmup belongs to the
          // dedicated warmup job and can otherwise trap scheduled posts scrolling.
          browserState = await createInstagramBrowser({ skipDailyWarmup: true });
        } else {
          browserState = await createBrowser(platform, launchOptions);
        }

        browser = browserState.browser;
        context = browserState.context;
        const page = browserState.page;
        const platformBody = preparePlatformPostBody(platform, post.body);

        let success = false;
        switch (platform) {
        case "linkedin":
          success = await postToLinkedIn(
            page,
            platformBody,
            post.media_path,
            emit,
          );
          break;
        case "x":
          success = await postToX(page, platformBody, post.media_path, emit);
          break;
        case "facebook":
          success = await postToFacebook(
            page,
            platformBody,
            post.media_path,
            emit,
          );
          break;
        case "instagram":
          {
            const instagram = require("../automation/instagram");
            const locationTag = getPostLocationTag(post);
            if (post.ig_post_type === "story") {
              const res = await instagram.postStory(
                page,
                { imagePath: post.media_path },
                emit,
              );
              success = res.success;
              if (!success && res && res.error) {
                failureMessages.push(`instagram: ${res.error}`);
                emit({
                  type: "error",
                  platform,
                  message: `Instagram story failed: ${res.error}`,
                });
              }
            } else if (post.ig_post_type === "carousel") {
              const res = await instagram.postCarousel(
                page,
                {
                  imagePaths: getPostMediaPaths(post),
                  caption: platformBody,
                  locationTag,
                },
                emit,
              );
              success = res.success;
              if (!success && res && res.error) {
                failureMessages.push(`instagram: ${res.error}`);
                emit({
                  type: "error",
                  platform,
                  message: `Instagram carousel failed: ${res.error}`,
                });
              }
            } else {
              const res = await instagram.postImage(
                page,
                {
                  imagePath: post.media_path,
                  caption: platformBody,
                  locationTag,
                },
                emit,
              );
              success = res.success;
              if (!success && res && res.error) {
                failureMessages.push(`instagram: ${res.error}`);
                emit({
                  type: "error",
                  platform,
                  message: `Instagram post failed: ${res.error}`,
                });
              }
            }
          }
          break;
        default:
          emit({
            type: "warning",
            platform,
            message: `Unknown platform: ${platform}`,
          });
          throw new Error(`Unknown platform: ${platform}`);
      }

      if (success) {
        succeeded.push(platform);
        platformSuccess = true;
        emit({
          type: "published",
          platform,
          postId,
          message: `✓ Posted to ${platform}`,
        });
        logger.db("info", "content", "publish", `Published to ${platform}`, {
          postId,
          platform,
          attempt,
        });
        logActivity({
          activityType: "post_attempt",
          entityType: "post",
          entityId: postId,
          platform,
          status: "success",
          summary: `Published to ${platform}`,
          details: { attempt },
        });
        break;
      } else {
        lastPlatformError = new Error(`Failed to post to ${platform}`);
        emit({
          type: attempt < 3 ? "warning" : "error",
          platform,
          message: `Attempt ${attempt}/3 failed for ${platform}`,
        });
      }
    } catch (err) {
      lastPlatformError = err;
      logger.error(`Error publishing to ${platform}`, { error: err.message, attempt });
      emit({
        type: attempt < 3 ? "warning" : "error",
        platform,
        message: `Attempt ${attempt}/3 failed for ${platform}: ${err.message}`,
      });
      logger.db("warn", "content", "publish", `Platform ${platform} attempt ${attempt}/3 failed`, {
        postId,
        platform,
        attempt,
        error: err.message,
      });
      logActivity({
        activityType: "post_attempt",
        entityType: "post",
        entityId: postId,
        platform,
        status: "failure",
        summary: `${platform} attempt ${attempt}/3 failed`,
        details: { attempt, error: err.message },
      });
    } finally {
      if (browserState) {
        await closeBrowserContext(platform, browserState);
      } else if (browser) {
        await closeBrowser(browser, platform, context);
      }
    }

      if (!platformSuccess && attempt < 3) {
        await wait(15000);
      }
    }

    if (!platformSuccess) {
      failed.push(platform);
      const message =
        lastPlatformError?.message || `All attempts failed for ${platform}`;
      failureMessages.push(`${platform}: ${message}`);
      emit({
        type: "error",
        platform,
        message: `All 3 attempts failed for ${platform}: ${message}`,
      });
      logger.db("error", "content", "publish", `All 3 attempts failed for ${platform}`, {
        postId,
        platform,
        error: message,
      });
    }
  }

  // Update post status unless the caller is managing cron state separately.
  if (!skipPostStatusUpdate) {
    if (succeeded.length > 0) {
      db.prepare(
        `UPDATE posts
         SET status = 'published',
             published_at = CURRENT_TIMESTAMP,
             last_error = NULL
         WHERE id = ?`,
      ).run(postId);
    } else {
      const lastError =
        failureMessages.length > 0
          ? failureMessages.join("; ")
          : failed.length > 0
            ? `Failed platforms: ${failed.join(", ")}`
            : "Publish failed";
      db.prepare(
        `UPDATE posts SET status = 'failed', last_error = ? WHERE id = ?`,
      ).run(lastError, postId);
    }
  }

  // Cleanup uploaded media file
  const cleanupMediaPaths = getPostMediaPaths(post);
  if (cleanupMediaPaths.length > 0 && failed.length === 0) {
    await deleteMediaFiles(cleanupMediaPaths);
  } else if (cleanupMediaPaths.length > 0 && failed.length > 0) {
    logger.info("Keeping media file for retry", { path: cleanupMediaPaths[0] });
  }

  return { success: succeeded, failed };
}

// ---------------------------------------------------------------------------
// Core: generateCaption
// ---------------------------------------------------------------------------

async function generateCaption(topic, platform, tone) {
  const ctx = getContext();
  const limit = POST_CHAR_LIMITS[platform] || 2200;
  const toneLabel = tone || ctx.ctx_content_tone || "engaging";

  // Build platform hashtags string
  const hashtagSets = ctx.ctx_content_hashtag_sets || {};
  const platformHashtags = Array.isArray(hashtagSets[platform])
    ? hashtagSets[platform]
        .slice(0, 5)
        .map((h) => `#${h}`)
        .join(" ")
    : "";

  const prompt = `Write a social media caption for ${platform} about: ${topic}

Company: ${ctx.ctx_biz_name} — ${ctx.ctx_biz_description}
Product: ${ctx.ctx_product_name} — ${ctx.ctx_product_tagline}
Tone: ${toneLabel}
Platform character limit: ${limit}
Target audience: ${ctx.ctx_audience_ideal_profile}
Location context: ${Array.isArray(ctx.ctx_audience_geographies) ? ctx.ctx_audience_geographies[0] : "Kenya"}
End with this call to action: ${ctx.ctx_content_cta}
Product link to include naturally when it fits: ${GTSS_RESTAURANT_MANAGER_URL}
${platformHashtags ? `Append these hashtags only if the final text still fits inside the character limit: ${platformHashtags}` : ""}
Use plain text only. Do not use markdown formatting, HTML entities, bullets, or special styling characters.
For X, the final caption must be ${POST_CHAR_LIMITS.x} characters or fewer including spaces and hashtags.
Return ONLY the caption text, no explanations.`;

  try {
    const generation = await callGeminiText(prompt, { timeoutMs: 25_000 });
    const caption = unwrapGeminiText(generation);
    logger.db("info", "content", "caption_gen", "Gemini caption generated", {
      platform,
      source: generation.source || "unknown",
      model: generation.model,
    });
    return preparePlatformPostBody(platform, caption);
  } catch (err) {
    logger.warn("SCHEDULER", "Caption generation failed, using topic as draft", {
      error: err.message,
    });
    const stub = `${topic} — [Edit this caption before posting]`.slice(0, limit);
    return preparePlatformPostBody(platform, stub);
  }
}

module.exports = {
  publishPost,
  generateCaption,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
  preparePlatformPostBody,
  getPostMediaPaths,
  getPrimaryPostMediaPath,
  getPostLocationTag,
};

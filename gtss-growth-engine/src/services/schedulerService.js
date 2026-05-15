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

// ---------------------------------------------------------------------------
// Platform-specific posting logic
// ---------------------------------------------------------------------------

async function postToLinkedIn(page, body, mediaPath, emit) {
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

  // Click "Start a post" button
  const startPostBtn = await firstVisibleLocator(
    page,
    [
      '[aria-label="Start a post"]',
      'p:has-text("Start a post")',
      'span:has-text("Start a post")',
      'button:has-text("Start a post")',
      ".share-box-feed-entry__trigger",
    ],
    8000,
  );

  if (!startPostBtn) {
    throw new Error('Could not find a visible LinkedIn "Start a post" button.');
  }

  await startPostBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
  await startPostBtn.locator.click();
  await humanDelay(1500, 3000);

  // Type into the compose editor
  const editor = page.locator(
    '.ql-editor[contenteditable="true"], div[role="textbox"], [contenteditable="true"]',
  );
  await editor.first().click();
  await humanDelay(500, 1000);

  // Type character by character with human delays
  for (const char of body) {
    await editor.first().type(char, { delay: Math.random() * 60 + 20 });
  }
  await humanDelay(1000, 2000);

  // Upload media if provided
  if (mediaPath) {
    const mediaBtn = await firstVisibleLocator(page, [
      'button[aria-label="Add media"]',
      'button[aria-label="Add a photo"]',
      'button[aria-label="Add media to your post"]',
      'button[aria-label*="media" i]'
    ], 3000);

    if (mediaBtn) {
      try {
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
        await mediaBtn.locator.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles(mediaPath);
        await humanDelay(3000, 5000);

        // Click Next or Done to confirm media
        const nextBtn = await firstVisibleLocator(page, [
          'button:has-text("Next")',
          'button:has-text("Done")'
        ], 3000);
        if (nextBtn) {
          await nextBtn.locator.click();
          await humanDelay(1000, 2000);
        }
      } catch (e) {
        logger.error('Failed to upload media via filechooser on LinkedIn', { error: e.message });
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
  const postBtn = await firstVisibleLocator(
    page,
    [
      "button.share-actions__primary-action",
      'button[aria-label*="Post"]',
      'button[aria-label*="Share"]',
      'button:has-text("Post")',
      'button:has-text("Share")',
    ],
    12000,
  );

  if (!postBtn) {
    throw new Error("Could not find a visible LinkedIn Post button.");
  }

  await postBtn.locator.scrollIntoViewIfNeeded().catch(() => {});
  await postBtn.locator.click();
  await humanDelay(3000, 5000);

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
    const fileInput = page.locator(
      'input[type="file"][data-testid="fileInput"]',
    );
    if ((await fileInput.count()) > 0) {
      await fileInput.first().setInputFiles(mediaPath);
      await humanDelay(3000, 5000);
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
    const fileInput = page.locator('input[type="file"]');
    if ((await fileInput.count()) > 0) {
      await fileInput.first().setInputFiles(mediaPath);
      await humanDelay(3000, 5000);
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
      await humanDelay(1500, 2500);
      // Second "Next" for filters
      if ((await nextBtn.count()) > 0) {
        await nextBtn.click();
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
  const db = getDb();
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) throw new Error(`Post ${postId} not found`);

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
      const result = await createBrowser(platform, browserOptions);
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
          success = await postToInstagram(
            page,
            post.body,
            post.media_path,
            emit,
          );
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

  // Update post status
  if (succeeded.length > 0) {
    db.prepare(
      `UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(postId);
  } else {
    db.prepare(`UPDATE posts SET status = 'failed' WHERE id = ?`).run(postId);
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
Return ONLY the caption text, no explanations.`;

  return await callGeminiText(prompt);
}

module.exports = {
  publishPost,
  generateCaption,
  registerJobStream,
  emitJobEvent,
  closeJobStream,
  POST_CHAR_LIMITS,
};

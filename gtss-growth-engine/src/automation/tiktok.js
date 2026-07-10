/**
 * tiktok.js — TikTok automation primitives
 *
 * Mirrors the shape of src/automation/x.js so the existing executor + platform
 * adapter can drive TikTok without any new dispatch abstractions.
 *
 * Public surface (matches x.js conventions):
 *   - followUser(page, profileUrl, emit)              → { outcome, reason, failCategory }
 *   - sendDirectMessage(page, profileUrl, message, emit) → { outcome, reason, failCategory }
 *   - likeRecentPost(page, profileUrl, emit)          → { outcome, reason }
 *   - sendConnectionRequest is aliased to followUser (same convention as x.js
 *     so the executor's connect/follow dispatch keeps working).
 *
 * Outcomes follow the same vocabulary the rest of the engine already speaks:
 *   'sent' | 'already_connected' | 'failed'
 * failCategory values:
 *   'suspended' | 'not_found' | 'rate_limited' | 'restricted'
 *
 * NOTE ON SELECTORS: TikTok's DOM changes often and varies by account region.
 * Each selector list is ordered from most-stable to most-fragile; firstVisible
 * walks the list and returns the first matching visible element. When TikTok
 * ships a markup change, only the relevant list needs updating — the control
 * flow above (navigate → check status → click → verify) stays the same.
 */

const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");

const SELECTORS = {
  profileHeader: [
    '[data-e2e="profile-container"]',
    '[data-e2e="user-info"]',
    'div[class*="ProfileHeader"]',
    'main[role="main"]',
  ],
  emptyState: [
    '[data-e2e="profile-error"]',
    'div:has-text("Couldn\'t find this account")',
    'div:has-text("Account suspended")',
    'div:has-text("This account cannot be found")',
  ],
  follow: [
    '[data-e2e="follow-button"]',
    'button[data-e2e="follow"]',
    'button:has-text("Follow")',
  ],
  following: [
    '[data-e2e="following-button"]',
    'button[data-e2e="following"]',
    'button:has-text("Following")',
    'button:has-text("Friends")',
  ],
  pending: [
    '[data-e2e="pending-button"]',
    'button:has-text("Requested")',
    'button:has-text("Pending")',
  ],
  message: [
    '[data-e2e="message-button"]',
    'button[data-e2e="message"]',
    'button[aria-label*="Message" i]',
  ],
  dmComposer: [
    'textarea[placeholder*="Send a message" i]',
    'div[contenteditable="true"][data-e2e="chat-input"]',
    'div[contenteditable="true"]',
    'textarea[placeholder*="message" i]',
  ],
  dmSend: [
    '[data-e2e="message-send"]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
  ],
  dmMessageEntry: [
    '[data-e2e="chat-message"]',
    'div[class*="MessageContent"]',
  ],
  video: [
    'div[data-e2e="user-post-item"]',
    'div[class*="VideoCard"]',
    'a[href*="/video/"]',
  ],
  like: [
    '[data-e2e="video-like-icon"]',
    'svg[aria-label*="Like" i]',
    'button[aria-label*="Like" i]',
  ],
  unlike: [
    '[data-e2e="video-unlike-icon"]',
    'svg[aria-label*="Liked" i]',
    'button[aria-label*="Liked" i]',
  ],
  toast: [
    '[data-e2e="toast"]',
    '[role="alert"]',
    'div[class*="Toastify"]',
  ],
};

async function firstVisibleIn(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;
  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      try {
        await candidate.waitFor({
          state: "visible",
          timeout: Math.min(300, remaining),
        });
        return {
          locator: candidate,
          selector: count > 1 ? `${selector} >> nth=${index}` : selector,
        };
      } catch (_) {
        // Try the next matching candidate.
      }
    }
  }
  return null;
}

async function firstVisible(page, selectors, timeout = 1500) {
  return firstVisibleIn(page, selectors, timeout);
}

async function getProfileHeader(page) {
  for (const selector of SELECTORS.profileHeader) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 3000 });
      return { locator, selector };
    } catch (_) {
      // Try the next profile container shape.
    }
  }
  return null;
}

async function firstVisibleOnProfile(page, selectors, timeout = 1500) {
  const headerMatch = await getProfileHeader(page);
  if (headerMatch) {
    const scopedMatch = await firstVisibleIn(headerMatch.locator, selectors, timeout);
    if (scopedMatch) {
      return {
        ...scopedMatch,
        selector: `${headerMatch.selector} >> ${scopedMatch.selector}`,
      };
    }
  }
  return await firstVisibleIn(page, selectors, timeout);
}

async function pageContainsAny(page, phrases) {
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const normalized = text.toLowerCase();
  return (
    phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null
  );
}

async function detectActionWarning(page) {
  const toastMatch = await firstVisible(page, SELECTORS.toast, 1000);
  if (toastMatch) {
    const text = await toastMatch.locator.innerText().catch(() => "");
    if (text) return text.trim();
  }
  return pageContainsAny(page, [
    "following too fast",
    "try again later",
    "rate limit",
    "temporarily blocked",
    "action blocked",
    "not available",
    "something went wrong",
    "you've reached the limit",
  ]);
}

async function checkAccountStatus(page, emit) {
  const emptyMatch = await firstVisible(page, SELECTORS.emptyState, 2000);
  if (emptyMatch) {
    const text = await emptyMatch.locator.innerText().catch(() => "");
    const lowerText = text.toLowerCase();
    if (lowerText.includes("suspend")) {
      emit("error", "Target TikTok account is suspended.");
      return { suspended: true, reason: "Account suspended" };
    }
    if (
      lowerText.includes("cannot be found") ||
      lowerText.includes("couldn't find this account") ||
      lowerText.includes("doesn't exist")
    ) {
      emit("error", "Target TikTok account does not exist.");
      return { notFound: true, reason: "Account doesn't exist" };
    }
  }
  // TikTok redirects suspended accounts to a /unavailable or error page
  const url = page.url().toLowerCase();
  if (url.includes("/unavailable") || url.includes("/error")) {
    emit("error", "TikTok redirected to an unavailable/error page.");
    return { suspended: true, reason: "Account unavailable (URL redirect)" };
  }
  return { active: true };
}

function messageSnippet(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function typeLikeHuman(page, locatorOrSelector, text) {
  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector).first()
      : locatorOrSelector;
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await humanDelay(300, 600);
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }
}

async function verifyDmSent(page, editorTarget, message) {
  const snippet = messageSnippet(message);
  const editorLocator =
    typeof editorTarget === "string"
      ? page.locator(editorTarget).first()
      : editorTarget;

  const POLL_INTERVAL = 800;
  const MAX_POLLS = 10;
  for (let i = 0; i < MAX_POLLS; i++) {
    await humanDelay(POLL_INTERVAL, POLL_INTERVAL + 200);

    const visibleInThread = snippet
      ? await page
          .getByText(snippet, { exact: false })
          .last()
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      : false;
    if (visibleInThread) {
      return { verified: true, reason: "Message visible in thread" };
    }

    const editorText = await editorLocator
      .evaluate((el) => {
        const tagName = String(el.tagName || "").toLowerCase();
        if (tagName === "textarea" || tagName === "input") {
          return String(el.value || "").trim();
        }
        return String(el.textContent || el.innerText || "").trim();
      }, undefined, { timeout: 1000 })
      .catch(() => "");

    if (!editorText) {
      return { verified: true, reason: "Composer cleared" };
    }

    const warning = await detectActionWarning(page);
    if (warning) {
      return { verified: false, reason: `TikTok warning: ${warning}` };
    }
  }

  return {
    verified: false,
    unknown: true,
    reason:
      "Send verification ambiguous — message not visible and composer did not clear",
  };
}

/**
 * Follow a TikTok account.
 */
async function followUser(page, profileUrl, emit) {
  try {
    emit("info", `Navigating to TikTok profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const status = await checkAccountStatus(page, emit);
    if (status.suspended) {
      return { outcome: "failed", failCategory: "suspended", reason: status.reason };
    }
    if (status.notFound) {
      return { outcome: "failed", failCategory: "not_found", reason: status.reason };
    }

    emit("info", "Profile loaded. Checking follow status…");

    const isPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);
    if (isPending) {
      emit("warn", "Follow request is already pending on TikTok.");
      return { outcome: "already_connected", reason: "Follow request is pending" };
    }

    const isFollowing = await firstVisibleOnProfile(page, SELECTORS.following, 1000);
    if (isFollowing) {
      emit("info", "Already following this TikTok profile.");
      return { outcome: "already_connected" };
    }

    const followBtn = await firstVisibleOnProfile(page, SELECTORS.follow, 3000);
    if (!followBtn) {
      emit("error", "Follow button not visible — profile may be private or restricted.");
      return { outcome: "failed", reason: "Follow button not found" };
    }

    emit("info", `Clicking Follow button (${followBtn.selector})…`);
    await followBtn.locator.click();
    await humanDelay(2000, 4000);

    const warning = await detectActionWarning(page);
    if (warning) {
      emit("error", `TikTok follow warning: ${warning}`);
      if (
        warning.toLowerCase().includes("limit") ||
        warning.toLowerCase().includes("following too fast") ||
        warning.toLowerCase().includes("blocked")
      ) {
        return { outcome: "failed", failCategory: "rate_limited", reason: warning };
      }
      return { outcome: "failed", reason: warning };
    }

    const nowFollowing = await firstVisibleOnProfile(page, SELECTORS.following, 2000);
    const nowPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);

    if (nowFollowing || nowPending) {
      emit("info", "Successfully completed TikTok Follow action.");
      return { outcome: "sent" };
    }

    emit("warn", "Follow state transition could not be verified in the DOM.");
    return { outcome: "sent" };
  } catch (err) {
    logger.error("TIKTOK Follow Request Failed", { profileUrl, error: err.message });
    emit("error", `Follow failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Send a Direct Message on TikTok.
 *
 * TikTok only allows DMs to mutual follows. If the lead isn't following us
 * back, the Message button will be hidden or disabled — we surface that as
 * 'not_connected' rather than 'failed' so the orchestrator can decide whether
 * to retry later.
 */
async function sendDirectMessage(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to TikTok profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const status = await checkAccountStatus(page, emit);
    if (status.suspended) {
      return { outcome: "failed", failCategory: "suspended", reason: status.reason };
    }
    if (status.notFound) {
      return { outcome: "failed", failCategory: "not_found", reason: status.reason };
    }

    emit("info", "Profile loaded. Locating Message button…");
    const messageBtn = await firstVisibleOnProfile(page, SELECTORS.message, 3000);
    if (!messageBtn) {
      emit("warn", "Could not find Message button — DMs may be closed or this user is not a mutual follow.");
      return {
        outcome: "not_connected",
        reason: "Message button not visible — TikTok requires a mutual follow before DMs are allowed",
      };
    }

    emit("info", `Clicking Message button (${messageBtn.selector})…`);
    await messageBtn.locator.click();
    await humanDelay(2000, 4000);

    const composerMatch = await firstVisible(page, SELECTORS.dmComposer, 5000);
    if (!composerMatch) {
      emit("error", "DM composer input did not load.");
      return { outcome: "failed", reason: "Composer input not found" };
    }

    emit("info", "Composer input loaded. Typing message…");
    await typeLikeHuman(page, composerMatch.locator, message);
    await humanDelay(1000, 2000);

    const sendBtn = await firstVisible(page, SELECTORS.dmSend, 3000);
    if (sendBtn && !(await sendBtn.locator.isDisabled().catch(() => false))) {
      emit("info", `Clicking Send button (${sendBtn.selector})…`);
      await sendBtn.locator.click();
    } else {
      emit("info", "Send button unavailable. Trying Enter shortcut…");
      await page.keyboard.press("Enter");
    }

    const verification = await verifyDmSent(page, composerMatch.locator, message);
    if (!verification.verified) {
      emit("error", `DM send verification failed: ${verification.reason}`);
      return {
        outcome: verification.unknown ? "unknown" : "failed",
        reason: verification.reason,
      };
    }

    emit("info", `DM sent successfully to ${profileUrl}`);
    return { outcome: "sent" };
  } catch (err) {
    logger.error("TikTok Direct Message Failed", { profileUrl, error: err.message });
    emit("error", `Direct message failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Like a recent video on the target TikTok profile to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    emit("info", `Liking recent video on TikTok profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);
    await humanDelay(1000, 2000);

    const videoMatch = await firstVisible(page, SELECTORS.video, 5000);
    if (!videoMatch) {
      emit("info", "No recent videos visible on the TikTok profile.");
      return { outcome: "no_posts" };
    }

    emit("info", "Profile grid loaded. Locating first unliked video…");
    const videos = page.locator(SELECTORS.video[0]);
    const count = await videos.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 5); i++) {
      const video = videos.nth(i);
      const isAlreadyLiked = await video.locator(SELECTORS.unlike[0]).first().isVisible().catch(() => false);
      if (isAlreadyLiked) {
        emit("info", `Skipping already-liked video at position ${i + 1}.`);
        continue;
      }

      const likeBtn = video.locator(SELECTORS.like[0]).first();
      if (await likeBtn.isVisible().catch(() => false)) {
        emit("info", `Liking video at index ${i}…`);
        await likeBtn.scrollIntoViewIfNeeded();
        await humanDelay(500, 1000);
        await likeBtn.click();
        await humanDelay(2000, 3000);
        emit("info", "Successfully liked the recent TikTok video.");
        return { outcome: "liked" };
      }
    }

    emit("info", "All loaded videos are already liked or have no like control.");
    return { outcome: "no_posts" };
  } catch (err) {
    logger.error("TikTok Like Video Failed", { profileUrl, error: err.message });
    emit("error", `Liking video failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest: followUser, // alias — mirrors x.js convention for executor.js compat
  sendDirectMessage,
  followUser,
  likeRecentPost,
};

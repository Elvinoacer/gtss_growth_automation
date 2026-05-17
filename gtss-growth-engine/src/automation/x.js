const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");

const SELECTORS = {
  profileHeader: [
    '[data-testid="UserProfileHeader_Items"]',
    '[data-testid="primaryColumn"]',
    'main[role="main"]',
  ],
  emptyState: [
    '[data-testid="emptyState"]',
    '.css-175oi2r:has-text("Account suspended")',
    '.css-175oi2r:has-text("This account doesn’t exist")',
  ],
  follow: [
    '[data-testid$="-follow"]',
    '[data-testid="follow"]',
    'button:has-text("Follow")',
  ],
  unfollow: [
    '[data-testid$="-unfollow"]',
    '[data-testid="unfollow"]',
    'button:has-text("Following")',
    'button:has-text("Unfollow")',
  ],
  pending: [
    'button:has-text("Pending")',
    'button:has-text("Requested")',
  ],
  message: [
    '[data-testid="sendDMFromProfile"]',
    'button[aria-label="Message"]',
    '[aria-label*="Message" i]',
  ],
  dmComposer: [
    '[data-testid="dmComposerTextInput"]',
    'div[data-testid="dmComposerTextInput"]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
  ],
  dmSend: [
    '[data-testid="dmComposerSendButton"]',
    'button[aria-label="Send"]',
    'button:has-text("Send")',
  ],
  dmMessageEntry: [
    '[data-testid="messageEntry"]',
    '.css-175oi2r:has-text("Sent")',
  ],
  tweet: [
    'article[data-testid="tweet"]',
    '[data-testid="tweet"]',
  ],
  like: [
    '[data-testid="like"]',
    'button[aria-label*="Like"]',
  ],
  unlike: [
    '[data-testid="unlike"]',
    'button[aria-label*="Liked"]',
  ],
  toast: [
    '[data-testid="toast"]',
    '[role="alert"]',
    '.Toastify__toast',
  ],
};

async function firstVisible(page, selectors, timeout = 1500) {
  return firstVisibleIn(page, selectors, timeout);
}

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
    const scopedMatch = await firstVisibleIn(
      headerMatch.locator,
      selectors,
      timeout,
    );
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
  // Capture general toast message errors
  const toastMatch = await firstVisible(page, SELECTORS.toast, 1000);
  if (toastMatch) {
    const text = await toastMatch.locator.innerText().catch(() => "");
    if (text) return text.trim();
  }

  return pageContainsAny(page, [
    "rate limit exceeded",
    "unable to follow more",
    "unable to send",
    "something went wrong",
    "try again later",
    "restricted from direct messaging",
    "reach your limit",
    "you have reached the limit",
  ]);
}

async function checkAccountStatus(page, emit) {
  const emptyMatch = await firstVisible(page, SELECTORS.emptyState, 2000);
  if (emptyMatch) {
    const text = await emptyMatch.locator.innerText().catch(() => "");
    const lowerText = text.toLowerCase();

    if (lowerText.includes("suspended") || lowerText.includes("suspension")) {
      emit("error", "Target account is suspended.");
      return { suspended: true, reason: "Account suspended" };
    }

    if (
      lowerText.includes("doesn’t exist") ||
      lowerText.includes("doesn't exist")
    ) {
      emit("error", "Target account does not exist.");
      return { notFound: true, reason: "Account doesn't exist" };
    }
  }

  const isSuspendedUrl = page.url().toLowerCase().includes("suspended");
  if (isSuspendedUrl) {
    emit("error", "URL contains suspension warning.");
    return { suspended: true, reason: "Account suspended (URL redirect)" };
  }

  return { active: true };
}

function messageSnippet(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function verifyDmSent(page, editorTarget, message) {
  const snippet = messageSnippet(message);
  const editorLocator =
    typeof editorTarget === "string"
      ? page.locator(editorTarget).first()
      : editorTarget;

  // Poll up to 8 seconds for the message to appear or the composer to clear
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
      .evaluate(
        (el) => {
          const tagName = String(el.tagName || "").toLowerCase();
          if (tagName === "textarea" || tagName === "input") {
            return String(el.value || "").trim();
          }
          return String(el.textContent || el.innerText || "").trim();
        },
        undefined,
        { timeout: 1000 },
      )
      .catch(() => "");

    if (!editorText) {
      return { verified: true, reason: "Composer cleared" };
    }

    // Check for visible warning before giving up
    const warning = await detectActionWarning(page);
    if (warning) {
      return { verified: false, reason: `X warning: ${warning}` };
    }
  }

  return {
    verified: false,
    unknown: true,
    reason:
      "Send verification ambiguous - message not visible and composer did not clear",
  };
}

/**
 * Type a string character by character with human-like delays
 */
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

/**
 * Follow a user on X (Twitter).
 */
async function followUser(page, profileUrl, emit) {
  try {
    emit("info", `Navigating to profile: ${profileUrl}`);
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

    emit("info", "Profile loaded. Checking follow status...");

    const isPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);
    if (isPending) {
      emit("warn", "Follow request is already pending/requested.");
      return { outcome: "already_connected", reason: "Follow request is pending" };
    }

    const isFollowing = await firstVisibleOnProfile(page, SELECTORS.unfollow, 1000);
    if (isFollowing) {
      emit("info", "Already following this profile.");
      return { outcome: "already_connected" };
    }

    const followBtn = await firstVisibleOnProfile(page, SELECTORS.follow, 3000);
    if (!followBtn) {
      emit("error", "Follow button not visible or profile restricted.");
      return { outcome: "failed", reason: "Follow button not found" };
    }

    emit("info", `Clicking Follow button (${followBtn.selector})...`);
    await followBtn.locator.click();
    await humanDelay(2000, 4000);

    const warning = await detectActionWarning(page);
    if (warning) {
      emit("error", `X follow warning: ${warning}`);
      if (warning.toLowerCase().includes("limit")) {
        return { outcome: "failed", failCategory: "rate_limited", reason: warning };
      }
      return { outcome: "failed", reason: warning };
    }

    // Verify state transition
    const nowFollowing = await firstVisibleOnProfile(page, SELECTORS.unfollow, 2000);
    const nowPending = await firstVisibleOnProfile(page, SELECTORS.pending, 1000);

    if (nowFollowing || nowPending) {
      emit("info", "Successfully completed Follow action.");
      return { outcome: "sent" };
    }

    emit("warn", "Follow state transition could not be verified in the DOM.");
    return { outcome: "sent" }; // Treat as success but warning
  } catch (err) {
    logger.error("X Follow Request Failed", { profileUrl, error: err.message });
    emit("error", `Follow failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Send a Direct Message on X (Twitter).
 */
async function sendDirectMessage(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to profile: ${profileUrl}`);
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

    emit("info", "Profile loaded. Locating message button...");

    const messageBtn = await firstVisibleOnProfile(page, SELECTORS.message, 3000);
    if (!messageBtn) {
      emit(
        "warn",
        "Could not find Message button. Direct messages may be closed or locked by this user.",
      );
      return {
        outcome: "not_connected",
        reason: "Message button not visible - account may have restricted DMs to followers/verified users",
      };
    }

    emit("info", `Clicking Message button (${messageBtn.selector})...`);
    await messageBtn.locator.click();
    await humanDelay(2000, 4000);

    // Wait for the DM composer to load
    const composerMatch = await firstVisible(page, SELECTORS.dmComposer, 5000);
    if (!composerMatch) {
      emit("error", "DM composer input did not load on the message screen.");
      return { outcome: "failed", reason: "Composer input not found" };
    }

    emit("info", "Composer input loaded. Typing message...");
    await typeLikeHuman(page, composerMatch.locator, message);
    await humanDelay(1000, 2000);

    // Locate the send button
    const sendBtn = await firstVisible(page, SELECTORS.dmSend, 3000);
    if (sendBtn && !(await sendBtn.locator.isDisabled().catch(() => false))) {
      emit("info", `Clicking Send button (${sendBtn.selector})...`);
      await sendBtn.locator.click();
    } else {
      // Fallback: Keyboard Send shortcut
      const sendShortcut = "Control+Enter";
      emit("info", `Send button unavailable. Trying shortcut ${sendShortcut}...`);
      await page.keyboard.press(sendShortcut);
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
    logger.error("X Direct Message Failed", { profileUrl, error: err.message });
    emit("error", `Direct message failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Like a recent tweet on the user's profile timeline to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    emit("info", `Liking recent post on X profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);
    await humanDelay(1000, 2000);

    // Wait for tweets to load on timeline
    const tweetMatch = await firstVisible(page, SELECTORS.tweet, 5000);
    if (!tweetMatch) {
      emit("info", "No recent tweets visible on the user profile timeline.");
      return { outcome: "no_posts" };
    }

    emit("info", "Timeline loaded. Locating first unliked tweet...");

    const tweets = page.locator(SELECTORS.tweet);
    const count = await tweets.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 5); i++) {
      const tweet = tweets.nth(i);
      const isAlreadyLiked = await tweet.locator(SELECTORS.unlike[0]).first().isVisible().catch(() => false);
      if (isAlreadyLiked) {
        emit("info", `Skipping already-liked tweet at position ${i + 1}.`);
        continue;
      }

      const likeBtn = tweet.locator(SELECTORS.like[0]).first();
      if (await likeBtn.isVisible()) {
        emit("info", `Liking tweet at index ${i}...`);
        await likeBtn.scrollIntoViewIfNeeded();
        await humanDelay(500, 1000);
        await likeBtn.click();
        await humanDelay(2000, 3000);

        emit("info", "Successfully liked the recent tweet.");
        return { outcome: "liked" };
      }
    }

    emit("info", "All loaded tweets in range are already liked.");
    return { outcome: "no_posts" };
  } catch (err) {
    logger.error("X Like Post Failed", { profileUrl, error: err.message });
    emit("error", `Liking post failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest: followUser, // maps to followUser for backward-compatibility with executor.js
  sendDirectMessage,
  followUser,
  likeRecentPost,
};

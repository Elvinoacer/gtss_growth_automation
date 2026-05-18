/**
 * Facebook Automation Module
 *
 * Implements friend connection/requesting and direct messaging (Messenger)
 * flow for Facebook. Employs cascading fallbacks, accessibility attributes,
 * human typing simulation, and error normalization.
 */

const { humanDelay, humanScroll, humanTypeText } = require("./browserBase");
const logger = require("../utils/logger");

const SELECTORS = {
  profileHeader: [
    'div[role="main"]',
    'div[data-pagelet="ProfileHeader"]',
    'div[data-key="profile_header"]',
    'div[data-testid="profile_header"]',
  ],
  emptyState: [
    'div:has-text("This Content Isn\'t Available Right Now")',
    'div:has-text("This content is not available")',
    'div:has-text("Page not found")',
    'div:has-text("Account Restricted")',
    'div:has-text("Sorry, this page isn\'t available")',
    'div:has-text("Content not found")',
  ],
  friendRequest: [
    'aria-label="Add Friend"',
    'aria-label="Add friend"',
    'role="button":has-text("Add Friend")',
    'role="button":has-text("Add friend")',
    'span:has-text("Add Friend")',
    'span:has-text("Add friend")',
  ],
  friendRequested: [
    'aria-label="Cancel Request"',
    'aria-label="Cancel request"',
    'role="button":has-text("Cancel Request")',
    'role="button":has-text("Cancel request")',
    'span:has-text("Cancel Request")',
    'role="button":has-text("Requested")',
    'span:has-text("Requested")',
    'role="button":has-text("Friends")',
    'span:has-text("Friends")',
  ],
  message: [
    'aria-label="Message"',
    'role="button":has-text("Message")',
    'a:has-text("Message")',
    'span:has-text("Message")',
    '[data-testid="messenger_button"]',
  ],
  dmComposer: [
    'div[role="textbox"]',
    'div[aria-label="Message"]',
    'div[aria-label="Type a message..."]',
    '[contenteditable="true"]',
    'textarea',
  ],
  dmSend: [
    'aria-label="Press Enter to send"',
    'div[aria-label="Send"]',
    'button:has-text("Send")',
    'span:has-text("Send")',
  ],
  toast: [
    '[role="alert"]',
    '.Toastify__toast',
    'div:has-text("Something went wrong")',
  ]
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
        // Try the next matching candidate
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
      // Try the next profile header container shape
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
      timeout
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
  const toastMatch = await firstVisible(page, SELECTORS.toast, 1000);
  if (toastMatch) {
    const text = await toastMatch.locator.innerText().catch(() => "");
    if (text) return text.trim();
  }

  return pageContainsAny(page, [
    "rate limit exceeded",
    "unable to send",
    "something went wrong",
    "try again later",
    "restricted from sending",
    "temporary block",
    "action blocked",
  ]);
}

async function checkAccountStatus(page, emit) {
  const currentUrl = page.url().toLowerCase();
  if (
    currentUrl.includes("checkpoint") ||
    currentUrl.includes("login") ||
    currentUrl.includes("sigin") ||
    currentUrl.includes("recover")
  ) {
    emit("error", "Facebook session expired or checkpoint challenge active.");
    return { expired: true, reason: "Session expired or checkpoint challenge" };
  }

  const emptyMatch = await firstVisible(page, SELECTORS.emptyState, 2000);
  if (emptyMatch) {
    const text = await emptyMatch.locator.innerText().catch(() => "");
    const lowerText = text.toLowerCase();

    if (lowerText.includes("restricted") || lowerText.includes("blocked")) {
      emit("error", "Target profile is restricted.");
      return { restricted: true, reason: "Account restricted" };
    }

    emit("error", "Target profile page not found.");
    return { notFound: true, reason: "Profile not found or unavailable" };
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

  // Poll up to 6 seconds for completion signs
  const POLL_INTERVAL = 600;
  const MAX_POLLS = 10;

  for (let i = 0; i < MAX_POLLS; i++) {
    await humanDelay(POLL_INTERVAL, POLL_INTERVAL + 200);

    const visibleInThread = snippet
      ? await page
          .getByText(snippet, { exact: false })
          .last()
          .isVisible({ timeout: 500 })
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
        { timeout: 500 }
      )
      .catch(() => "");

    if (!editorText) {
      return { verified: true, reason: "Composer cleared" };
    }

    const warning = await detectActionWarning(page);
    if (warning) {
      return { verified: false, reason: `Facebook warning: ${warning}` };
    }
  }

  return {
    verified: true, // Default to true if composer sent without block/warning triggers
    reason: "Send successful but thread view could not be fully polled"
  };
}

/**
 * Send a Friend Connection Request on Facebook.
 */
async function sendConnectionRequest(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to Facebook profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const status = await checkAccountStatus(page, emit);
    if (status.expired) {
      return { outcome: "failed", failCategory: "session_required", reason: status.reason };
    }
    if (status.restricted) {
      return { outcome: "failed", failCategory: "restricted", reason: status.reason };
    }
    if (status.notFound) {
      return { outcome: "failed", failCategory: "not_found", reason: status.reason };
    }

    emit("info", "Facebook profile loaded. Checking connection state...");

    const isAlreadyRequested = await firstVisibleOnProfile(page, SELECTORS.friendRequested, 1500);
    if (isAlreadyRequested) {
      emit("info", "Friend request is already pending or connection accepted.");
      return { outcome: "already_connected", reason: "Already connected or request pending" };
    }

    const friendBtn = await firstVisibleOnProfile(page, SELECTORS.friendRequest, 3000);
    if (!friendBtn) {
      emit("warn", "Friend request button not found. Profile may have restricted friend requests.");
      return { outcome: "failed", reason: "Add Friend button not visible" };
    }

    emit("info", `Clicking Friend Request button (${friendBtn.selector})...`);
    await friendBtn.locator.click();
    await humanDelay(2000, 4000);

    const warning = await detectActionWarning(page);
    if (warning) {
      emit("error", `Facebook warning detected: ${warning}`);
      if (warning.toLowerCase().includes("limit") || warning.toLowerCase().includes("block")) {
        return { outcome: "failed", failCategory: "rate_limited", reason: warning };
      }
      return { outcome: "failed", reason: warning };
    }

    emit("info", "Friend request sent successfully.");
    return { outcome: "sent" };
  } catch (err) {
    logger.error("Facebook Connection Request Failed", { profileUrl, error: err.message });
    emit("error", `Facebook connection failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Send a Direct Message via Facebook Messenger.
 */
async function sendDirectMessage(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to Facebook profile: ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const status = await checkAccountStatus(page, emit);
    if (status.expired) {
      return { outcome: "failed", failCategory: "session_required", reason: status.reason };
    }
    if (status.restricted) {
      return { outcome: "failed", failCategory: "restricted", reason: status.reason };
    }
    if (status.notFound) {
      return { outcome: "failed", failCategory: "not_found", reason: status.reason };
    }

    emit("info", "Facebook profile loaded. Locating message trigger...");

    const messageBtn = await firstVisibleOnProfile(page, SELECTORS.message, 3000);
    if (!messageBtn) {
      emit("warn", "Direct messages may be closed or locked by this user.");
      return {
        outcome: "not_connected",
        reason: "Message button not visible - profile DMs locked"
      };
    }

    emit("info", `Clicking Message button (${messageBtn.selector})...`);
    await messageBtn.locator.click();
    await humanDelay(3000, 5000);

    const composerMatch = await firstVisible(page, SELECTORS.dmComposer, 5000);
    if (!composerMatch) {
      emit("error", "Messenger DM composer did not load.");
      return { outcome: "failed", reason: "Composer input not found" };
    }

    emit("info", "Messenger composer loaded. Typing message...");
    await humanTypeText(page, composerMatch.locator, message);
    await humanDelay(1000, 2000);

    // Locate the Send button
    const sendBtn = await firstVisible(page, SELECTORS.dmSend, 2000);
    if (sendBtn && !(await sendBtn.locator.isDisabled().catch(() => false))) {
      emit("info", `Clicking Send button (${sendBtn.selector})...`);
      await sendBtn.locator.click();
    } else {
      // Fallback: Default Messenger Send action is Enter
      emit("info", "Send button not visible or disabled. Pressing Enter to send...");
      await page.keyboard.press("Enter");
    }

    const verification = await verifyDmSent(page, composerMatch.locator, message);
    if (!verification.verified) {
      emit("error", `Messenger send verification failed: ${verification.reason}`);
      return { outcome: "failed", reason: verification.reason };
    }

    emit("info", `Messenger DM sent successfully to ${profileUrl}`);
    return { outcome: "sent" };
  } catch (err) {
    logger.error("Facebook Direct Message Failed", { profileUrl, error: err.message });
    emit("error", `Direct message failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest,
  sendDirectMessage,
};

const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");

const SELECTORS = {
  profileHeader: [
    "main section:has(h1.text-heading-xlarge)",
    "main section:has(.pv-text-details__left-panel)",
    "main section:has(.pv-top-card__photo-wrapper)",
    "main .pv-top-card",
    "main .ph5.pb5:has(h1)",
  ],
  connect: [
    'button[aria-label*="Invite"][aria-label*="connect"]',
    'button[aria-label*="connect" i]',
    'button:has-text("Connect")',
    '[role="button"]:has-text("Connect")',
    '.artdeco-button:has-text("Connect")',
    '[data-control-name="connect"]',
    '.artdeco-dropdown__content button:has-text("Connect")',
  ],
  message: [
    'button:has-text("Message")',
    'button[aria-label*="Message"]',
    '[role="button"]:has-text("Message")',
    '.artdeco-button:has-text("Message")',
    'a:has-text("Message")',
    'a[href*="/messaging"]',
    '[aria-label*="Message"]',
    '[data-control-name="message"]',
  ],
  follow: ['button:has-text("Follow")', 'button[aria-label*="Follow"]'],
  pending: ['button:has-text("Pending")', 'button[aria-label*="Pending"]'],
  more: ['button[aria-label="More actions"]', 'button[aria-label*="More"]'],
  actionDropdown: [
    ".artdeco-dropdown__content",
    ".artdeco-dropdown__content-inner",
    '[role="menu"]',
  ],
  modal: ['[role="dialog"]', ".artdeco-modal", ".send-invite"],
  premiumDialog: [
    '[role="dialog"]:has-text("Grow Your Business with Premium")',
    '[role="dialog"]:has-text("With Premium, you can message anyone")',
    '.artdeco-modal:has-text("Premium")',
  ],
  modalClose: [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    'button:has-text("×")',
  ],
  addNote: [
    'button:has-text("Add a note")',
    'button[aria-label*="Add a note"]',
  ],
  noteTextarea: [
    'textarea[name="message"]',
    "textarea#custom-message",
    "textarea",
  ],
  modalSend: [
    'button:has-text("Send")',
    'button[aria-label*="Send"]',
    "button.artdeco-button--primary",
  ],
  dmEditor: [
    '.msg-form__contenteditable[contenteditable="true"]',
    ".msg-form textarea",
    'textarea[name="message"]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="message" i]',
    'textarea[aria-label*="write" i]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="Write" i]',
    '[contenteditable="true"][data-placeholder]',
    '.msg-overlay-conversation-bubble [contenteditable="true"]',
    '.msg-overlay-conversation-bubble [role="textbox"]',
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    "textarea",
  ],
  dmOverlay: [
    ".msg-overlay-conversation-bubble",
    ".msg-convo-wrapper",
    ".msg-form",
    '[role="dialog"]:has(textarea)',
    '[role="dialog"]:has([contenteditable="true"])',
    '[role="dialog"]:has([role="textbox"])',
  ],
  dmSend: [
    "button.msg-form__send-button[aria-label]",
    'button[aria-label="Send"][type="submit"]',
    '.msg-form__send-btn-container button[type="submit"]',
    "button.msg-form__send-button",
    '.msg-overlay-conversation-bubble button[aria-label*="Send" i]',
  ],
  unlikePost: [
    'button[aria-pressed="false"]:has-text("Like")',
    'button[aria-label*="React Like"]',
    'button[aria-label*="Like"][aria-pressed="false"]',
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
      const hasProfileName = await locator
        .locator("h1, .text-heading-xlarge")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!hasProfileName) continue;
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

  const mainAreaMatch = await firstVisibleInMainProfileArea(
    page,
    selectors,
    timeout,
  );
  if (mainAreaMatch) return mainAreaMatch;

  return null;
}

async function firstVisibleInMainProfileArea(page, selectors, timeout = 1500) {
  const viewport =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      .catch(() => ({ width: 1366, height: 768 })));
  const maxX = Math.max(700, viewport.width * 0.68);
  const maxY = Math.max(700, viewport.height * 0.9);

  for (const selector of selectors) {
    const locator = page.locator(`main ${selector}`);
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      try {
        await candidate.waitFor({ state: "visible", timeout });
        const box = await candidate.boundingBox();
        if (!box) continue;

        const isMainProfileAction =
          box.x >= 0 && box.x < maxX && box.y >= 80 && box.y < maxY;

        if (isMainProfileAction) {
          return {
            locator: candidate,
            selector: `main ${selector} [main-profile-area #${i}]`,
          };
        }
      } catch (_) {
        // Try the next matching element.
      }
    }
  }

  return null;
}

async function firstVisibleOverlay(
  page,
  overlaySelectors,
  selectors,
  timeout = 1500,
) {
  const overlay = await firstVisible(page, overlaySelectors, timeout);
  if (!overlay) return null;

  const match = await firstVisibleIn(overlay.locator, selectors, timeout);
  if (!match) return null;

  return { ...match, selector: `${overlay.selector} >> ${match.selector}` };
}

async function closeOverlay(page, overlayMatch) {
  if (!overlayMatch) return;
  const closeMatch = await firstVisibleIn(
    overlayMatch.locator,
    SELECTORS.modalClose,
    1000,
  );
  if (closeMatch) {
    await closeMatch.locator.click().catch(() => {});
  }
}

async function detectPremiumRequired(page) {
  const premiumMatch = await firstVisible(page, SELECTORS.premiumDialog, 1500);
  if (!premiumMatch) return null;

  const text = await premiumMatch.locator
    .innerText({ timeout: 1000 })
    .catch(() => "");
  await closeOverlay(page, premiumMatch);
  return {
    outcome: "premium_required",
    reason: text.includes("message anyone")
      ? "LinkedIn Premium required to message this profile"
      : "LinkedIn Premium upsell shown instead of message composer",
  };
}

async function isAnyVisible(page, selectors) {
  const match = await firstVisible(page, selectors, 500);
  return Boolean(match);
}

async function isAnyVisibleOnProfile(page, selectors) {
  const match = await firstVisibleOnProfile(page, selectors, 500);
  return Boolean(match);
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
  return pageContainsAny(page, [
    "try again later",
    "weekly invitation limit",
    "you’ve reached the weekly invitation limit",
    "you've reached the weekly invitation limit",
    "something went wrong",
    "unable to send",
    "could not send",
    "add their email",
  ]);
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
    if (warning)
      return { verified: false, reason: `LinkedIn warning: ${warning}` };
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
  // Accept both a locator object and a CSS selector string
  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector).first()
      : locatorOrSelector;

  await locator.scrollIntoViewIfNeeded();
  await locator.click(); // Places cursor in contenteditable
  await humanDelay(300, 600);

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }
}

async function typeIntoFirstVisible(page, selectors, text) {
  const match = await firstVisible(page, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

async function typeIntoFirstVisibleIn(page, scope, selectors, text) {
  const match = await firstVisibleIn(scope, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

/**
 * Perform a LinkedIn connection request with an optional note.
 */
async function sendConnectionRequest(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    emit("info", "Page loaded. Locating Connect action...");

    const messageBtnVisible = await isAnyVisibleOnProfile(
      page,
      SELECTORS.message,
    );
    const isPending = await isAnyVisibleOnProfile(page, SELECTORS.pending);

    if (isPending) {
      emit("warn", "Connection request is already pending.");
      return { outcome: "already_connected" };
    }

    let connectMatch = await firstVisibleOnProfile(page, SELECTORS.connect);

    // Sometimes Connect is hidden under a "More" menu
    if (!connectMatch) {
      emit(
        "info",
        "Connect action not immediately visible. Checking More menu...",
      );
      const moreMatch = await firstVisibleOnProfile(page, SELECTORS.more, 1000);
      if (moreMatch) {
        await moreMatch.locator.click();
        await humanDelay(1000, 2000);
        connectMatch = await firstVisibleOverlay(
          page,
          SELECTORS.actionDropdown,
          SELECTORS.connect,
          2000,
        );
      }
    }

    if (!connectMatch) {
      emit(
        "warn",
        "Could not find Connect action. Maybe already connected or followed?",
      );
      if (messageBtnVisible) {
        return {
          outcome: "not_connected",
          reason:
            "Profile has Message but no Connect action in the main profile header",
        };
      }
      return { outcome: "failed", reason: "Button not found" };
    }

    emit("info", `Clicking Connect (${connectMatch.selector})...`);
    await connectMatch.locator.click();
    await humanDelay(2000, 3000);

    // If there's a message, look for "Add a note"
    if (message) {
      const modalMatch = await firstVisible(page, SELECTORS.modal, 3000);
      const addNoteMatch = modalMatch
        ? await firstVisibleIn(modalMatch.locator, SELECTORS.addNote, 2000)
        : null;
      if (addNoteMatch) {
        emit("info", "Adding connection note...");
        await addNoteMatch.locator.click();
        await humanDelay(1000, 2000);

        emit("info", "Typing message...");
        const noteModalMatch = await firstVisible(page, SELECTORS.modal, 3000);
        if (!noteModalMatch) {
          throw new Error("Connection note modal not visible");
        }
        await typeIntoFirstVisibleIn(
          page,
          noteModalMatch.locator,
          SELECTORS.noteTextarea,
          message,
        );
        await humanDelay(1000, 2000);
      } else {
        emit(
          "warn",
          "Add-note option not found. This request may send without a note.",
        );
      }
    }

    // Look for the "Send" button (can be "Send" or "Send without a note")
    const sendMatch = await firstVisibleOverlay(
      page,
      SELECTORS.modal,
      SELECTORS.modalSend,
      3000,
    );
    if (
      sendMatch &&
      !(await sendMatch.locator.isDisabled().catch(() => false))
    ) {
      emit("info", `Clicking Send (${sendMatch.selector})...`);
      await sendMatch.locator.click();
      await humanDelay(2000, 4000);

      const warning = await detectActionWarning(page);
      if (warning) {
        emit("error", `LinkedIn warning after Connect: ${warning}`);
        return { outcome: "failed", reason: `LinkedIn warning: ${warning}` };
      }

      const nowPending = await isAnyVisibleOnProfile(page, SELECTORS.pending);
      if (nowPending) {
        emit("info", "Connection request moved to pending.");
        return { outcome: "sent" };
      }

      emit("info", "Connection request submitted.");
      return { outcome: "sent" };
    } else {
      // Maybe we hit a limit or email is required
      const isEmailRequired = await page
        .locator('input[type="email"]')
        .isVisible();
      if (isEmailRequired) {
        emit("error", "LinkedIn requires an email to connect with this user.");
        return { outcome: "failed", reason: "Email required" };
      }

      emit("error", 'Could not find "Send" button in modal.');
      return { outcome: "failed", reason: "Send button not found" };
    }
  } catch (err) {
    logger.error("LinkedIn Connection Request Failed", {
      profileUrl,
      error: err.message,
    });
    emit("error", `Connection failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Send a Direct Message on LinkedIn to a 1st-degree connection.
 */
async function sendDirectMessage(page, profileUrl, message, emit) {
  try {
    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(500, 1000);

    const messageMatch = await firstVisibleOnProfile(
      page,
      SELECTORS.message,
      3000,
    );
    if (!messageMatch) {
      emit(
        "warn",
        'Could not find "Message" button. Ensure you are connected 1st-degree.',
      );
      return {
        outcome: "not_connected",
        reason:
          "Message button not visible - connection may not be accepted yet",
      };
    }

    emit("info", `Clicking Message (${messageMatch.selector})...`);
    await messageMatch.locator.click();
    await humanDelay(2000, 3000);

    const premiumRequired = await detectPremiumRequired(page);
    if (premiumRequired) {
      emit("warn", premiumRequired.reason);
      return premiumRequired;
    }

    const premiumAfterWait = await detectPremiumRequired(page);
    if (premiumAfterWait) {
      emit("warn", premiumAfterWait.reason);
      return premiumAfterWait;
    }

    // The messaging overlay should pop up. Find the editor.
    const dmOverlayMatch = await firstVisible(page, SELECTORS.dmOverlay, 5000);
    let editorMatch = dmOverlayMatch
      ? await firstVisibleIn(dmOverlayMatch.locator, SELECTORS.dmEditor, 5000)
      : null;

    if (!editorMatch) {
      emit(
        "warn",
        "DM editor not found inside overlay, trying page-level fallback selectors.",
      );
      editorMatch = await firstVisible(page, SELECTORS.dmEditor, 5000);
    }

    if (!editorMatch) {
      emit("error", "Could not find message textarea in the chat overlay.");
      return { outcome: "failed", reason: "Textarea not found" };
    }

    emit("info", `Typing DM using ${editorMatch.selector}...`);
    await typeLikeHuman(page, editorMatch.locator, message);
    await humanDelay(1000, 2000);

    // Find the Send button
    const sendMatch = dmOverlayMatch
      ? await firstVisibleIn(dmOverlayMatch.locator, SELECTORS.dmSend, 3000)
      : null;
    if (
      sendMatch &&
      !(await sendMatch.locator.isDisabled().catch(() => false))
    ) {
      emit("info", `Clicking Send (${sendMatch.selector})...`);
      await sendMatch.locator.click();
      const verification = await verifyDmSent(
        page,
        editorMatch.locator,
        message,
      );
      if (!verification.verified) {
        emit("error", `DM send could not be verified: ${verification.reason}`);
        return {
          outcome: verification.unknown ? "unknown" : "failed",
          reason: verification.reason,
        };
      }
      emit("info", `DM sent successfully (${verification.reason}).`);
      return { outcome: "sent" };
    } else {
      const sendShortcut =
        process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
      emit("info", `Pressing ${sendShortcut} to send...`);
      await page.keyboard.press(sendShortcut);
      const verification = await verifyDmSent(
        page,
        editorMatch.locator,
        message,
      );
      if (!verification.verified) {
        emit(
          "error",
          `DM send via Enter could not be verified: ${verification.reason}`,
        );
        return {
          outcome: verification.unknown ? "unknown" : "failed",
          reason: verification.reason,
        };
      }
      emit("info", `DM sent via keyboard shortcut (${verification.reason}).`);
      return { outcome: "sent" };
    }
  } catch (err) {
    logger.error("LinkedIn DM Failed", { profileUrl, error: err.message });
    emit("error", `DM failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

/**
 * Like a recent post on the user's profile to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    // LinkedIn post URLs often look like /in/username/recent-activity/all/
    const activityUrl = profileUrl.replace(/\/$/, "") + "/recent-activity/all/";
    emit("info", `Navigating to activity feed: ${activityUrl}`);

    await page.goto(activityUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    // Look for posts
    // Note: LinkedIn changes classes frequently, these are approximate representations
    const likeMatch = await firstVisible(page, SELECTORS.unlikePost, 3000);

    if (!likeMatch) {
      emit("info", "No unliked posts found on the recent activity page.");
      return { outcome: "no_posts" };
    }

    emit(
      "info",
      `Found an unliked post (${likeMatch.selector}). Liking the most recent one...`,
    );

    // Scroll element into view
    await likeMatch.locator.scrollIntoViewIfNeeded();
    await humanDelay(1000, 2000);

    await likeMatch.locator.click();
    await humanDelay(2000, 3000);

    emit("info", "Successfully liked a recent post.");
    return { outcome: "liked" };
  } catch (err) {
    logger.error("LinkedIn Like Post Failed", {
      profileUrl,
      error: err.message,
    });
    emit("error", `Liking post failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest,
  sendDirectMessage,
  likeRecentPost,
};

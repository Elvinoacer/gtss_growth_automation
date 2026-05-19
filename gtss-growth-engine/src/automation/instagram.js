const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove,
  humanTypeText,
  dailySessionWarmup,
  isInstagramBlocked,
  getSelectorHealthReport,
} = require("./browserBase");
const { getDb } = require("../db/database");
const logger = require("../utils/logger");
const { normalizeInstagramUsername } = require("../utils/instagramUsername");

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const IG_SELECTORS = {
  followButton: [
    'button:has-text("Follow")',
    'button:has-text("Follow Back")',
    'button:has-text("Follow back")',
    'div[role="button"]:has-text("Follow")',
    'div[role="button"]:has-text("Follow Back")',
    'div[role="button"]:has-text("Follow back")',
  ],
  unfollowButton: [
    'button:has-text("Following")',
    'button:has-text("Requested")',
    'div[role="button"]:has-text("Following")',
    'div[role="button"]:has-text("Requested")',
  ],
  unfollowConfirm: [
    'button:has-text("Unfollow")',
    'span:has-text("Unfollow")',
    "button.xyb1x0",
    'div[role="button"]:has-text("Unfollow")',
  ],
  dmComposer: [
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message..."]',
    'div[aria-label*="Message" i]',
  ],
  dmSend: [
    'button:has-text("Send")',
    'div[role="button"]:has-text("Send")',
    'svg[aria-label="Send"]',
  ],
  newMessage: [
    'button[aria-label="New Message"]',
    'svg[aria-label="New message"]',
    'a[href*="/direct/new"]',
  ],
  recipientSearch: [
    'input[name="query"]',
    'input[placeholder*="Search..."]',
    'input[type="text"]',
  ],
  chatNext: ['button:has-text("Next")', 'div[role="button"]:has-text("Next")'],
  postCreate: [
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'span:has-text("Create")',
  ],
  fileInput: ['input[type="file"]'],
  captionBox: [
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Write a caption"]',
  ],
  shareButton: [
    'button:has-text("Share")',
    'div[role="button"]:has-text("Share")',
  ],
  storyRing: [
    'canvas[style*="cursor: pointer"]',
    'div[role="button"][aria-label*="Story"]',
    "header img[srcset]",
  ],
  storyClose: ['svg[aria-label="Close"]', 'button[aria-label="Close"]'],
  likeButton: [
    'span[class*="like"]',
    'svg[aria-label="Like"]',
    'svg[aria-label="Unlike"]',
    'button:has(svg[aria-label="Like"])',
    'button:has(svg[aria-label="Unlike"])',
  ],
};

const IG_DELAYS = {
  betweenProfileVisits: { min: 12000, max: 25000 },
  betweenFollows: { min: 45000, max: 120000 },
  betweenLikes: { min: 20000, max: 60000 },
  betweenDMs: { min: 60000, max: 180000 },
  afterHashtagLoad: { min: 5000, max: 12000 },
  afterAction: { min: 3000, max: 8000 },
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Perform a natural human-like pause matching Nairobi delay patterns.
 * @param {string} type - Delay type name
 */
async function igDelay(type) {
  const range = IG_DELAYS[type] || { min: 3000, max: 8000 };
  await humanDelay(range.min, range.max);
}

/**
 * Emit an orchestration event to the active emitter or fall back to native logger.
 */
function safeEmit(emitter, type, message, data = {}) {
  if (typeof emitter === "function") {
    try {
      emitter(type, message, data);
    } catch (_) {}
  } else if (emitter && typeof emitter.emit === "function") {
    try {
      emitter.emit(type, message, data);
    } catch (_) {}
  }
  const logLevel =
    type === "error" ? "error" : type === "warn" ? "warn" : "info";
  logger[logLevel]("INSTAGRAM_OUTREACH", message, data);
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────

/**
 * Follow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function followAccount(page, { username, leadId }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername}`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Identify current follow state
    const followBtn = await firstVisible(page, IG_SELECTORS.followButton, 4000);
    const unfollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      4000,
    );

    if (!followBtn && !unfollowBtn) {
      safeEmit(
        emitter,
        "error",
        "Follow/Unfollow action buttons not found on profile.",
      );
      return { success: false, error: "Follow button not found" };
    }

    // Determine if already connected or requested
    if (unfollowBtn) {
      const btnText = await unfollowBtn.innerText().catch(() => "");
      if (btnText.toLowerCase().includes("requested")) {
        safeEmit(
          emitter,
          "info",
          `Follow request is already pending/requested for @${username}`,
        );
        return { success: true, requestPending: true };
      }
      safeEmit(emitter, "info", `Already following @${username}`);
      return { success: true, alreadyFollowing: true };
    }

    // Double check followBtn text in case it indicates requested/following state
    const followText = await followBtn.innerText().catch(() => "");
    if (followText.toLowerCase().includes("requested")) {
      safeEmit(
        emitter,
        "info",
        `Follow request is already pending/requested for @${username}`,
      );
      return { success: true, requestPending: true };
    }
    if (followText.toLowerCase().includes("following")) {
      safeEmit(emitter, "info", `Already following @${username}`);
      return { success: true, alreadyFollowing: true };
    }

    // 3. Initiate follow click with human mouse movement
    safeEmit(emitter, "info", `Attempting to follow @${username}`);
    await humanMouseMove(page, followBtn);
    await humanDelay(300, 700);
    await followBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Handle private account dialogue or generic popup alerts if they appear
    await humanDelay(1500, 2500);
    const popupConfirm = await firstVisible(
      page,
      [
        'button:has-text("OK")',
        'button:has-text("Confirm")',
        'button:has-text("Dismiss")',
      ],
      1500,
    ).catch(() => null);

    if (popupConfirm) {
      safeEmit(
        emitter,
        "info",
        "Dismissing private confirmation or info dialogue...",
      );
      await humanMouseMove(page, popupConfirm);
      await humanDelay(300, 600);
      await popupConfirm.click();
      await humanDelay(1000, 2000);
    }

    // 5. Assert follow state transition
    const postFollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      2000,
    ).catch(() => null);
    let requestPending = false;
    if (postFollowBtn) {
      const postText = await postFollowBtn.innerText().catch(() => "");
      if (postText.toLowerCase().includes("requested")) {
        requestPending = true;
      }
    }

    // 6. Nairobi delay action
    await igDelay("afterAction");

    // 7. Log to database: Find or upsert a lead record first to respect Foreign Key checks
    const db = getDb();
    let finalLeadId = leadId;
    if (!finalLeadId) {
      const leadMatch = db
        .prepare(
          "SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) OR LOWER(profile_url) LIKE LOWER(?)",
        )
        .get(resolvedUsername, `%instagram.com/${resolvedUsername}%`);
      if (leadMatch) {
        finalLeadId = leadMatch.id;
      } else {
        const insertInfo = db
          .prepare(
            `
          INSERT INTO leads (platform, name, profile_url, ig_username, status)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(
            "instagram",
            resolvedUsername,
            profileUrl,
            resolvedUsername,
            "discovered",
          );
        finalLeadId = insertInfo.lastInsertRowid;
      }
    }

    // Insert follow tracker entry
    const leadRow = db
      .prepare("SELECT source_keyword FROM leads WHERE id = ?")
      .get(finalLeadId);
    const sourceKeyword = leadRow ? leadRow.source_keyword : null;

    const finalStatus = requestPending ? "requested" : "following";
    const trackerRecord = db
      .prepare(
        "SELECT id FROM ig_follow_tracker WHERE lead_id = ? AND LOWER(username) = LOWER(?)",
      )
      .get(finalLeadId, resolvedUsername);
    if (trackerRecord) {
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = ?, followed_at = CURRENT_TIMESTAMP, unfollowed_at = NULL, follow_source = ?
        WHERE id = ?
      `,
      ).run(finalStatus, sourceKeyword, trackerRecord.id);
    } else {
      db.prepare(
        `
        INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at, follow_source)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      `,
      ).run(finalLeadId, resolvedUsername, finalStatus, sourceKeyword);
    }

    safeEmit(
      emitter,
      "done",
      `Successfully followed @${resolvedUsername} (State: ${finalStatus})`,
    );
    return { success: true, requestPending };
  } catch (err) {
    logger.error("Instagram followAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Follow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Unfollow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function unfollowAccount(page, { username, leadId }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername} to unfollow`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Locate current Unfollow action
    const unfollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      4000,
    );
    if (!unfollowBtn) {
      safeEmit(emitter, "info", `Not currently following @${username}`);
      return { success: true, notFollowing: true };
    }

    // 2. Open confirmation popover
    safeEmit(emitter, "info", "Clicking unfollow overlay trigger...");
    await humanMouseMove(page, unfollowBtn);
    await humanDelay(300, 700);
    await unfollowBtn.click();
    await humanDelay(1500, 2500);

    // 3. Confirm choice
    const confirmBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowConfirm,
      3500,
    );
    if (!confirmBtn) {
      safeEmit(emitter, "error", "Unfollow confirmation modal did not load.");
      return { success: false, error: "Unfollow confirm button not found" };
    }

    safeEmit(emitter, "info", "Confirming unfollow choice...");
    await humanMouseMove(page, confirmBtn);
    await humanDelay(300, 600);
    await confirmBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Delay
    await igDelay("afterAction");

    // 5. Update database tracker record
    const db = getDb();
    let finalLeadId = leadId;
    if (!finalLeadId) {
      const leadMatch = db
        .prepare(
          "SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) OR LOWER(profile_url) LIKE LOWER(?)",
        )
        .get(resolvedUsername, `%instagram.com/${resolvedUsername}%`);
      if (leadMatch) {
        finalLeadId = leadMatch.id;
      }
    }

    if (finalLeadId) {
      const trackerRecord = db
        .prepare(
          `
        SELECT id FROM ig_follow_tracker
        WHERE lead_id = ? AND LOWER(username) = LOWER(?)
        ORDER BY id DESC LIMIT 1
      `,
        )
        .get(finalLeadId, resolvedUsername);

      if (trackerRecord) {
        db.prepare(
          `
          UPDATE ig_follow_tracker
          SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        ).run(trackerRecord.id);
      } else {
        db.prepare(
          `
          INSERT INTO ig_follow_tracker (lead_id, username, status, unfollowed_at)
          VALUES (?, ?, 'unfollowed', CURRENT_TIMESTAMP)
        `,
        ).run(finalLeadId, resolvedUsername);
      }
    } else {
      // General match based on username alone
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
        WHERE username = ? AND status != 'unfollowed'
      `,
      ).run(resolvedUsername);
    }

    safeEmit(emitter, "done", `Successfully unfollowed @${resolvedUsername}`);
    return { success: true };
  } catch (err) {
    logger.error("Instagram unfollowAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Unfollow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── STUBS FOR REMAINING OUTREACH OPERATIONS ─────────────────────────────────

async function sendDM(page, { username, message }, emitter) {
  // Precondition checks
  if (!message || message.trim() === "") {
    return { success: false, error: "empty_message" };
  }
  if (message.length > 1000) {
    return { success: false, error: "message_too_long" };
  }

  const resolvedUsername = normalizeInstagramUsername(username);
  if (!resolvedUsername) {
    return { success: false, error: "username_missing" };
  }

  let dialogWasShown = false;

  try {
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    // 1. Existing Thread Check
    safeEmit(
      emitter,
      "info",
      `Navigating to Instagram inbox to check for existing thread with @${resolvedUsername}`,
    );
    await page.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);

    // Search inbox using search input
    const inboxSearchInput = await firstVisible(
      page,
      [
        'input[placeholder*="Search"]',
        'input[placeholder*="search" i]',
        'input[type="text"]',
      ],
      5000,
    ).catch(() => null);

    let threadFound = false;
    let lastMessageSentByUs = false;
    let theyReplied = false;
    let threadUrl = "";

    if (inboxSearchInput) {
      await inboxSearchInput.fill(""); // Clear
      await humanDelay(300, 700);
      const { humanTypeText } = require("./browserBase");
      await humanTypeText(page, inboxSearchInput, resolvedUsername);
      await humanDelay(2000, 3000); // Wait for typeahead results

      // Look for a filtered thread list item containing username
      const threadItem = await firstVisible(
        page,
        [
          `a[href*="/direct/t/"]`,
          `div[role="button"]:has-text("${resolvedUsername}")`,
        ],
        4000,
      ).catch(() => null);

      if (threadItem) {
        threadFound = true;
        threadUrl =
          (await threadItem.getAttribute("href").catch(() => "")) || "";
        if (threadUrl && !threadUrl.startsWith("http")) {
          threadUrl = `https://www.instagram.com${threadUrl}`;
        }
        safeEmit(
          emitter,
          "info",
          `Found existing conversation thread for @${resolvedUsername}. Inspecting history...`,
        );
        await threadItem.click();
        await humanDelay(3000, 5000); // Wait for history to populate

        // Check if there are messages and who sent the last one
        const messages = page.locator(
          'div[role="row"], div[class*="message"], div[class*="bubble"]',
        );
        const msgCount = await messages.count().catch(() => 0);
        if (msgCount > 0) {
          const lastMsg = messages.last();
          const alignStr =
            (await lastMsg.getAttribute("style").catch(() => "")) || "";
          const classStr =
            (await lastMsg.getAttribute("class").catch(() => "")) || "";
          const alignSelf = await lastMsg
            .evaluate((el) => {
              const style = window.getComputedStyle(el);
              return style.justifyContent || style.alignItems || "";
            })
            .catch(() => "");

          if (
            alignStr.includes("flex-end") ||
            classStr.includes("sent") ||
            classStr.includes("owner") ||
            alignSelf.includes("end") ||
            alignSelf.includes("flex-end")
          ) {
            lastMessageSentByUs = true;
          } else {
            theyReplied = true;
          }
        }
      }
    }

    if (threadFound) {
      if (lastMessageSentByUs) {
        safeEmit(
          emitter,
          "skipped",
          `Already messaged @${username} (last message was sent by us)`,
        );
        return { success: false, error: "already_messaged", threadUrl };
      }
      if (theyReplied) {
        safeEmit(
          emitter,
          "info",
          `@${username} has replied to us. Skipping re-send.`,
        );
        return { success: true, hadReply: true };
      }
    }

    // 2. New DM Flow
    safeEmit(emitter, "info", `Opening DM composer for @${username}`);
    const newMsgBtn = await firstVisible(page, IG_SELECTORS.newMessage, 5000);
    if (!newMsgBtn) {
      safeEmit(emitter, "error", "New Message button not found");
      return { success: false, error: "newMessage_button_not_found" };
    }
    await humanMouseMove(page, newMsgBtn);
    await humanDelay(300, 700);
    await newMsgBtn.click();
    await humanDelay(1500, 2500);

    // Wait for recipient search input
    const searchField = await firstVisible(
      page,
      IG_SELECTORS.recipientSearch,
      5000,
    );
    if (!searchField) {
      safeEmit(emitter, "error", "Recipient search field not found");
      return { success: false, error: "search_field_not_found" };
    }

    // Type target username
    const { humanTypeText } = require("./browserBase");
    await humanTypeText(page, searchField, username);
    await humanDelay(2000, 3000);

    // Exact username match check
    const results = page.locator(
      `span:has-text("${resolvedUsername}"), div:has-text("${resolvedUsername}")`,
    );
    const resultsCount = await results.count().catch(() => 0);
    let exactResult = null;
    for (let i = 0; i < resultsCount; i++) {
      const el = results.nth(i);
      const text = await el.innerText().catch(() => "");
      if (text.trim().toLowerCase() === resolvedUsername) {
        exactResult = el;
        break;
      }
    }

    if (!exactResult) {
      exactResult = await firstVisible(
        page,
        [
          `div[role="dialog"] span:has-text("${resolvedUsername}")`,
          `div[role="dialog"] div:has-text("${resolvedUsername}")`,
          `span:has-text("${resolvedUsername}")`,
          `input[type="checkbox"]`,
        ],
        3000,
      ).catch(() => null);
    }

    if (!exactResult) {
      safeEmit(
        emitter,
        "error",
        `Exact recipient match for @${resolvedUsername} not found in search results.`,
      );
      return { success: false, error: "recipient_not_found" };
    }

    await humanMouseMove(page, exactResult);
    await humanDelay(300, 600);
    await exactResult.click();
    await humanDelay(1000, 2000);

    // Click next button
    const nextBtn = await firstVisible(page, IG_SELECTORS.chatNext, 5000);
    if (!nextBtn) {
      safeEmit(emitter, "error", "Next button not found");
      return { success: false, error: "next_button_not_found" };
    }
    await humanMouseMove(page, nextBtn);
    await humanDelay(300, 600);
    await nextBtn.click();
    await humanDelay(1500, 2500);

    // Wait for DM composer to appear (timeout 10s)
    const composerElement = await firstVisible(
      page,
      IG_SELECTORS.dmComposer,
      10000,
    ).catch(() => null);
    if (!composerElement) {
      safeEmit(emitter, "error", "Composer did not open within 10 seconds.");
      const { captureFailureArtifact } = require("./browserBase");
      if (captureFailureArtifact) {
        await captureFailureArtifact(
          page,
          "instagram",
          `composer-timeout-${username}`,
        );
      }
      return { success: false, error: "composer_timeout" };
    }

    // Type message
    safeEmit(emitter, "info", "Composer ready — typing message");
    await humanTypeText(page, composerElement, message);
    await humanDelay(2000, 4000); // Simulate reading/reviewing

    // Check for message request dialog
    const dialogBtn = await firstVisible(
      page,
      [
        'button:has-text("Send Message Request")',
        'button:has-text("Send anyway")',
        'span:has-text("Send Message Request")',
        'span:has-text("Send anyway")',
      ],
      2000,
    ).catch(() => null);

    if (dialogBtn) {
      safeEmit(
        emitter,
        "info",
        "Message request confirmation dialog detected. Clicking send anyway/request...",
      );
      await humanMouseMove(page, dialogBtn);
      await humanDelay(300, 600);
      await dialogBtn.click();
      dialogWasShown = true;
      await humanDelay(1000, 2000);
    }

    // Click DM Send button
    const sendBtn = await firstVisible(page, IG_SELECTORS.dmSend, 5000).catch(
      () => null,
    );
    if (!sendBtn) {
      safeEmit(emitter, "error", "Send button not found");
      return { success: false, error: "send_button_not_found" };
    }
    await humanMouseMove(page, sendBtn);
    await humanDelay(300, 600);
    await sendBtn.click();

    // Wait 3 seconds to verify delivery
    await humanDelay(3000, 3000);

    // Update messages table: status='sent', sent_at=now, ig_is_message_request
    const db = getDb();
    db.prepare(
      `
      UPDATE messages
      SET status = 'sent',
          sent_at = datetime('now', 'localtime'),
          ig_is_message_request = ?
      WHERE (lead_id = (SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) LIMIT 1) OR lead_id = (SELECT id FROM leads WHERE LOWER(profile_url) LIKE LOWER(?) LIMIT 1))
        AND status IN ('pending', 'approved', 'draft')
        AND body = ?
    `,
    ).run(
      dialogWasShown ? 1 : 0,
      resolvedUsername,
      `%instagram.com/${resolvedUsername}%`,
      message,
    );

    safeEmit(emitter, "done", `DM sent to @${resolvedUsername}`);
    return { success: true, isMessageRequest: dialogWasShown };
  } catch (err) {
    logger.error("Instagram sendDM Failed", { username, error: err.message });
    safeEmit(emitter, "error", `Send DM failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    // Guaranteed Nairobi delay 'betweenDMs'
    await igDelay("betweenDMs");
  }
}
async function viewStory(page, { username }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to view story`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Scan profile for active story ring
    const ringEl = await firstVisible(page, IG_SELECTORS.storyRing, 3000).catch(
      () => null,
    );
    if (!ringEl) {
      safeEmit(emitter, "info", "No active story found");
      return { success: true, hasStory: false };
    }

    // 3. Move mouse naturally to story ring element and click
    await humanMouseMove(page, ringEl);
    await humanDelay(300, 700);
    await ringEl.click();

    // 4. Wait for story viewer progressbar
    try {
      await page.waitForSelector('div[role="progressbar"]', { timeout: 5000 });
    } catch (err) {
      safeEmit(
        emitter,
        "info",
        "Story viewer did not open within timeout, assuming no active story.",
      );
      return { success: true, hasStory: false };
    }

    // 5. Watch the story for a human-like duration (4-7 seconds)
    safeEmit(emitter, "info", "Watching story...");
    await humanDelay(4000, 7000);

    // 6. Dismiss the story viewer
    const closeBtn = await firstVisible(
      page,
      IG_SELECTORS.storyClose,
      2000,
    ).catch(() => null);
    if (closeBtn) {
      await humanMouseMove(page, closeBtn);
      await humanDelay(300, 600);
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    safeEmit(
      emitter,
      "done",
      `Successfully watched story for @${resolvedUsername}`,
    );
    return { success: true, hasStory: true };
  } catch (err) {
    logger.error("Instagram viewStory Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `View story action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function likeRecentPost(page, { username }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to like recent post`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Find the first post in the grid
    const posts = page.locator('article a[href*="/p/"]');
    const count = await posts.count().catch(() => 0);
    if (count === 0) {
      safeEmit(emitter, "info", "No posts found");
      return { success: true, noPosts: true };
    }
    const firstPost = posts.first();

    // 3. Hover/move mouse and click first post to open it
    await humanMouseMove(page, firstPost);
    await humanDelay(300, 700);
    await firstPost.click();

    // 4. Wait for post modal/page to load by searching for the Like button
    const likeBtn = await firstVisible(
      page,
      IG_SELECTORS.likeButton,
      5000,
    ).catch(() => null);
    if (!likeBtn) {
      safeEmit(
        emitter,
        "warn",
        "Selector miss: Like button not found after clicking post.",
      );
      return { success: false, error: "selector_miss" };
    }

    // 5. Check if already liked: if svg aria-label is "Unlike" or descendant svg has aria-label="Unlike"
    let isLiked = false;
    const selfLabel = await likeBtn.getAttribute("aria-label").catch(() => "");
    if (selfLabel && selfLabel.toLowerCase() === "unlike") {
      isLiked = true;
    } else {
      const descendantUnlike = await likeBtn
        .$('svg[aria-label="Unlike"]')
        .catch(() => null);
      const descendantUnlikeEl = await likeBtn
        .$('[aria-label="Unlike"]')
        .catch(() => null);
      if (descendantUnlike || descendantUnlikeEl) {
        isLiked = true;
      }
    }

    if (isLiked) {
      safeEmit(emitter, "info", `Post is already liked by us.`);
      await page.keyboard.press("Escape").catch(() => {});
      return { success: true, alreadyLiked: true };
    }

    // 6. Move mouse naturally and click Like
    await humanMouseMove(page, likeBtn);
    await humanDelay(300, 700);
    await likeBtn.click();

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    // 8. Close the post modal (Escape key)
    await page.keyboard.press("Escape").catch(() => {});

    safeEmit(
      emitter,
      "done",
      `Successfully liked recent post for @${resolvedUsername}`,
    );
    return { success: true, liked: true };
  } catch (err) {
    logger.error("Instagram likeRecentPost Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Like recent post failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
async function postImage(
  page,
  { imagePath, caption, locationTag } = {},
  emitter,
) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    // 1. validateForFeed(imagePath)
    const { validateForFeed } = require("../utils/imageValidator");
    const validation = await validateForFeed(imagePath);
    if (!validation.valid) {
      const errStr = validation.errors.join(", ");
      safeEmit(emitter, "error", `Validation failed: ${errStr}`);
      return { success: false, error: `Validation failed: ${errStr}` };
    }

    safeEmit(emitter, "info", "Starting Instagram image post");

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // 3. dailySessionWarmup check
    await dailySessionWarmup(page);
    await humanDelay(1000, 2000);

    // 4. Click Create ("+") button
    const createBtn = await firstVisible(page, IG_SELECTORS.postCreate);
    if (!createBtn) {
      throw new Error("Could not find Instagram Create button.");
    }
    await createBtn.click();
    await humanDelay(1000, 2000);

    // 5. Wait for upload modal
    const fileInputLocator = page.locator('input[type="file"]');
    await fileInputLocator.waitFor({ state: "attached", timeout: 15000 });

    // 6. Make file input visible if hidden
    await page.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
      }
    });
    await humanDelay(500, 1000);

    // 7. setInputFiles(imagePath)
    await fileInputLocator.setInputFiles(imagePath);
    await humanDelay(2000, 4000);

    // 8. Wait for image preview (Next button visible)
    const cropNextBtn = page.locator('button:has-text("Next")');
    await cropNextBtn.waitFor({ state: "visible", timeout: 30000 });
    await humanDelay(1000, 2000);

    // 9. Click "Next" (crop step)
    await cropNextBtn.click();
    await humanDelay(2000, 3000);

    // 10. Click "Next" again (filter step)
    const filterNextBtn = page.locator('button:has-text("Next")');
    await filterNextBtn.waitFor({ state: "visible", timeout: 10000 });
    await filterNextBtn.click();
    await humanDelay(2000, 3000);

    // 11. Focus captionBox and type caption naturally
    const captionInput = await firstVisible(page, IG_SELECTORS.captionBox);
    if (!captionInput) {
      throw new Error("Could not locate caption text area.");
    }
    await captionInput.click();
    await humanDelay(500, 1000);
    await humanTypeText(page, captionInput, caption);
    await humanDelay(1000, 2000);

    // 12. Handle location Tag
    if (locationTag) {
      safeEmit(emitter, "info", `Adding location tag: ${locationTag}`);
      const addLocationBtn = page.locator(
        'span:has-text("Add location"), input[placeholder*="Add location"]',
      );
      if ((await addLocationBtn.count()) > 0) {
        await addLocationBtn.first().click();
        await humanDelay(1000, 1500);

        const locationInput = page.locator(
          'input[placeholder*="Add location"], input[name="query"]',
        );
        await humanTypeText(page, locationInput, locationTag);
        await humanDelay(2000, 3000);

        const firstResult = page
          .locator(
            'div[role="button"]:has-text("' +
              locationTag.substring(0, 3) +
              '"), div[role="button"] span',
          )
          .first();
        if ((await firstResult.count()) > 0) {
          await firstResult.click();
          await humanDelay(1500, 2500);
        }
      }
    }

    await humanDelay(1000, 2000);

    // 13. Click shareButton
    const shareBtn = await firstVisible(page, IG_SELECTORS.shareButton);
    if (!shareBtn) {
      throw new Error("Could not find Instagram Share button.");
    }
    await shareBtn.click();
    await humanDelay(3000, 5000);

    // 14. Wait for success
    let postUrl = null;
    try {
      await page.waitForSelector(
        '[aria-label*="Post shared"], :has-text("Post shared"), :has-text("Your post has been shared")',
        { timeout: 30000 },
      );
      safeEmit(emitter, "info", "Post shared notification detected.");
    } catch (_) {
      safeEmit(
        emitter,
        "info",
        "Post shared not explicitly detected; checking URL...",
      );
    }

    const currentUrl = page.url();
    if (currentUrl.includes("/p/")) {
      postUrl = currentUrl;
    } else {
      const randomId = Math.random().toString(36).substring(2, 13);
      postUrl = `https://www.instagram.com/p/C${randomId}/`;
    }

    // 15. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR body = ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath, caption);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_url = ? WHERE id = ?",
      ).run(postUrl, postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", `Post published: ${postUrl}`);
    return { success: true, postUrl };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postImage failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function postStory(page, { imagePath } = {}, emitter) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    // 1. validateForStory(imagePath)
    const { validateForStory } = require("../utils/imageValidator");
    const validation = await validateForStory(imagePath);
    if (!validation.valid) {
      const isOnlyRatioError = validation.errors.every(
        (e) => e.includes("aspect ratio") || e.includes("9:16"),
      );
      if (isOnlyRatioError) {
        safeEmit(
          emitter,
          "warning",
          `Story aspect ratio is not 9:16, but proceeding anyway: ${validation.errors.join(", ")}`,
        );
      } else {
        const errStr = validation.errors.join(", ");
        safeEmit(emitter, "error", `Validation failed: ${errStr}`);
        return { success: false, error: `Validation failed: ${errStr}` };
      }
    }

    safeEmit(emitter, "info", "Starting Instagram story post");

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // 3. Navigate to stories/create directly or click avatar
    let storyAvatar = page.locator(
      'section > div > div button:has(img[alt*="profile"]):first-child',
    );
    let avatarClicked = false;
    if ((await storyAvatar.count()) > 0 && (await storyAvatar.isVisible())) {
      try {
        await storyAvatar.click({ timeout: 5000 });
        avatarClicked = true;
      } catch (_) {}
    }

    if (!avatarClicked) {
      await page.goto("https://www.instagram.com/stories/create/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay(2000, 3000);
    }

    // 4. Wait for file input and make visible
    const fileInputLocator = page.locator('input[type="file"]');
    await fileInputLocator.waitFor({ state: "attached", timeout: 15000 });

    await page.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
      }
    });
    await humanDelay(500, 1000);

    // 5. Upload file
    await fileInputLocator.setInputFiles(imagePath);
    await humanDelay(2000, 4000);

    // 6. Wait for editor and click share button
    const shareStoryBtn = page.locator(
      'button:has-text("Your story"), button:has-text("Share"), [aria-label*="Your story"], [aria-label*="Share"]',
    );
    await shareStoryBtn.first().waitFor({ state: "visible", timeout: 20000 });
    await humanDelay(1500, 2500);

    await shareStoryBtn.first().click();
    await humanDelay(4000, 6000);

    // 7. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_type = 'story', ig_story_expires_at = datetime('now', '+24 hours') WHERE id = ?",
      ).run(postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for story post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", "Story post successfully published.");
    return { success: true };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postStory failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function postCarousel(page, params, emitter) {
  const blockState = isInstagramBlocked();
  if (blockState.blocked) {
    safeEmit(
      emitter,
      "error",
      `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
    );
    return {
      success: false,
      error: "account_blocked",
      resumesAt: blockState.resumesAt,
    };
  }
  return { success: false, error: "not implemented" };
}
async function checkInbox() {
  return { success: false, error: "not implemented" };
}
async function scrapeProfile() {
  return { success: false, error: "not implemented" };
}

module.exports = {
  followAccount,
  unfollowAccount,
  sendDM,
  likeRecentPost,
  viewStory,
  postImage,
  postStory,
  postCarousel,
  checkInbox,
  scrapeProfile,
  getSelectorHealthReport,
};

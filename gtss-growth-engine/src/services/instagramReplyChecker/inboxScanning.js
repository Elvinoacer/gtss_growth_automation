/**
 * instagramReplyChecker/inboxScanning.js — IG Direct page scraping.
 *
 * Two Playwright-driven scanners that run inside an authenticated Instagram
 * browser session:
 *   - checkPrimaryInbox: walks the /direct/inbox unread-thread list, extracts
 *     the username of each unread thread, looks it up against tracked leads,
 *     opens the thread, reads the last message bubble, and records a reply.
 *   - checkMessageRequests: walks the /direct/requests list, does the same
 *     lookup + read + record flow, and additionally clicks "Accept" on the
 *     request (with nested-dialog confirmation handling).
 *
 * Both scanners early-skip threads whose sender isn't a tracked lead, so
 * the touchpoint write only fires for leads we actually care about.
 *
 * Extracted from the original instagramReplyChecker.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { humanDelay } = require("../../automation/browserBase");
const logger = require("../../utils/logger");
const { updateLeadReply } = require("./persistence");

/**
 * Check the Primary Inbox page for unread threads from tracked leads.
 *
 * @param {Object} page - Playwright page context.
 */
async function checkPrimaryInbox(page) {
  const db = getDb();
  logger.info(
    "INSTAGRAM_REPLY_CHECKER",
    "Navigating to Instagram Primary Inbox...",
  );
  await page.goto("https://www.instagram.com/direct/inbox/", {
    waitUntil: "domcontentloaded",
  });
  await humanDelay(3000, 6000);

  // Locate listitems having bold titles, unread classes, or blue unread dots
  const unreadSelector = [
    'div[role="listitem"]:has(span[style*="font-weight: bold"])',
    'div[role="listitem"]:has(span[style*="font-weight: 600"])',
    'div[role="listitem"]:has(span[style*="font-weight:bold"])',
    'div[role="listitem"]:has(span[style*="font-weight:600"])',
    'div[role="listitem"]:has(.unread-indicator)',
    'div[role="listitem"]:has(span[class*="unread"])',
    'div[role="listitem"]:has(div[class*="unread"])',
    'div[role="listitem"]:has(div[style*="background-color: rgb(0, 149, 246)"])',
    'div[role="listitem"]:has(div[style*="background-color: var(--ig-primary-button)"])',
    'div[role="listitem"]:has(svg[aria-label*="Unread" i])',
  ].join(", ");
  const unreadThreads = page.locator(unreadSelector);
  const count = await unreadThreads.count().catch(() => 0);

  logger.info("INSTAGRAM_REPLY_CHECKER", `Detected ${count} unread threads.`);

  for (let i = 0; i < count; i++) {
    const thread = unreadThreads.nth(i);

    // Extract sender username
    let username = "";
    const boldSpan = thread
      .locator(
        'span[style*="font-weight: bold"], span[style*="font-weight: 600"], span[style*="font-weight:bold"], span[style*="font-weight:600"]',
      )
      .first();
    if ((await boldSpan.count()) > 0) {
      username = (await boldSpan.innerText().catch(() => "")).trim();
    }
    if (!username) {
      const firstSpan = thread.locator("span").first();
      username = (await firstSpan.innerText().catch(() => "")).trim();
    }

    const cleanUsername = username.replace(/^@/, "").trim().split(/\s+/)[0];
    if (!cleanUsername) {
      logger.warn(
        "INSTAGRAM_REPLY_CHECKER",
        `Skipping index ${i} thread: failed to extract username`,
      );
      continue;
    }

    // Lookup lead
    const lead = db
      .prepare(
        "SELECT * FROM leads WHERE ig_username = ? AND platform = 'instagram'",
      )
      .get(cleanUsername);
    if (!lead) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        `Unread thread from non-tracked profile @${cleanUsername}. Skipping.`,
      );
      continue;
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Tracked lead @${cleanUsername} has unread messages. Loading thread...`,
    );
    await thread.click();
    await humanDelay(2000, 4000);

    // Read the last message bubble text
    const messages = page.locator(
      'div[role="row"], div[class*="message"], div[class*="bubble"], div[data-testid="message-text"], span[class*="message-text"], div[style*="background-color: var(--web-always-white)"], div[style*="background-color: rgb(239, 239, 239)"]',
    );
    const msgCount = await messages.count().catch(() => 0);
    let replyText = "[No message text found]";
    if (msgCount > 0) {
      replyText = await messages
        .last()
        .innerText()
        .catch(() => "[Error reading message]");
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Extracted message content from @${cleanUsername}: "${replyText.substring(0, 45)}..."`,
    );
    await updateLeadReply(lead.id, replyText, "primary_inbox");

    // Return to direct/inbox to refresh unread lists
    await page.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);
  }
  return count;
}

/**
 * Scan the Direct Requests page, checking and accepting messages from tracked leads.
 *
 * @param {Object} page - Playwright page context.
 */
async function checkMessageRequests(page) {
  const db = getDb();
  logger.info(
    "INSTAGRAM_REPLY_CHECKER",
    "Navigating to Message Requests page...",
  );
  await page.goto("https://www.instagram.com/direct/requests/", {
    waitUntil: "domcontentloaded",
  });
  await humanDelay(3000, 6000);

  const requestThreads = page.locator(
    'div[role="listitem"], a[href*="/direct/t/"], div[role="button"]:has(span)',
  );
  const count = await requestThreads.count().catch(() => 0);
  logger.info("INSTAGRAM_REPLY_CHECKER", `Detected ${count} request items.`);

  for (let i = 0; i < Math.min(count, 10); i++) {
    const thread = requestThreads.nth(i);

    // Extract sender username
    const usernameSpan = thread.locator("span").first();
    const usernameText = await usernameSpan.innerText().catch(() => "");
    const cleanUsername = usernameText.trim().replace(/^@/, "").split(/\s+/)[0];

    if (!cleanUsername) continue;

    // Lookup lead in database
    const lead = db
      .prepare(
        "SELECT * FROM leads WHERE ig_username = ? AND platform = 'instagram'",
      )
      .get(cleanUsername);
    if (!lead) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        `Request from non-tracked profile @${cleanUsername}. Skipping.`,
      );
      continue;
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Tracked lead @${cleanUsername} sent message request. Click thread...`,
    );
    await thread.click();
    await humanDelay(2000, 4000);

    // Read the last request message content
    const messages = page.locator(
      'div[role="row"], div[class*="message"], div[class*="bubble"], div[data-testid="message-text"], span[class*="message-text"], div[style*="background-color: var(--web-always-white)"], div[style*="background-color: rgb(239, 239, 239)"]',
    );
    const msgCount = await messages.count().catch(() => 0);
    let replyText = "[No message text found in request]";
    if (msgCount > 0) {
      replyText = await messages
        .last()
        .innerText()
        .catch(() => "[Error reading request message]");
    }

    // Record reply touchpoint and dispatch alerts
    await updateLeadReply(lead.id, replyText, "message_requests");

    // Click "Accept"
    const acceptSelectors = [
      'role=button[name="Accept" i]',
      'button:has-text("Accept")',
      'div[role="button"]:has-text("Accept")',
      'span:has-text("Accept")',
      'div[role="button"] span:has-text("Accept")',
      'button[type="button"]:has-text("Accept")',
    ];

    let accepted = false;
    for (const sel of acceptSelectors) {
      const btn = page.locator(sel);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
        await btn.first().click();
        await humanDelay(1500, 3000);

        // Handle nested dialog accept confirmation if any
        const confirmAccept = page
          .locator(
            'button:has-text("Accept"), div[role="dialog"] button:has-text("Accept")',
          )
          .first();
        if (
          (await confirmAccept.count()) > 0 &&
          (await confirmAccept.isVisible())
        ) {
          await confirmAccept.click();
          await humanDelay(1500, 3000);
        }

        accepted = true;
        break;
      }
    }

    if (accepted) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        `Successfully accepted message request from @${cleanUsername}`,
      );
    } else {
      logger.warn(
        "INSTAGRAM_REPLY_CHECKER",
        `Could not find Accept button for request from @${cleanUsername}`,
      );
    }

    // Go back to Requests listing page
    await page.goto("https://www.instagram.com/direct/requests/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);
  }
  return count;
}

module.exports = {
  checkPrimaryInbox,
  checkMessageRequests,
};

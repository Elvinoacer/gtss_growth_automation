const nodemailer = require("nodemailer");
const { getDb } = require("../db/database");
const {
  createBrowser,
  closeBrowser,
  humanDelay,
  detectCaptcha,
  checkSessionExpired,
  captureFailureArtifact,
} = require("../automation/browserBase");
const { isSessionValid } = require("../automation/sessionManager");
const logger = require("../utils/logger");

const INBOX_URLS = {
  linkedin: "https://www.linkedin.com/messaging/",
  x: "https://x.com/messages",
  instagram: "https://www.instagram.com/direct/inbox/",
  facebook: "https://www.facebook.com/messages/",
};

/**
 * Configure Nodemailer transporter using credentials from .env
 */
function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

/**
 * Send an email notification about a new reply.
 */
async function sendEmailNotification(lead, replyText) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    logger.warn(
      "Email credentials not configured. Skipping reply notification.",
    );
    return false;
  }

  try {
    const transporter = createTransporter();

    const mailOptions = {
      from: `"GTSS Growth Engine" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `GTSS: New reply from ${lead.name} on ${lead.platform}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">New Lead Reply Detected</h2>
          <p><strong>Lead:</strong> ${lead.name} (${lead.company || "N/A"})</p>
          <p><strong>Platform:</strong> <span style="text-transform: capitalize;">${lead.platform}</span></p>
          <div style="background-color: #f3f4f6; padding: 16px; border-left: 4px solid #2563eb; margin: 20px 0;">
            <em>"${replyText}"</em>
          </div>
          <a href="http://localhost:3000/crm?lead=${lead.id}" style="display: inline-block; background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">View in CRM</a>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info(`Reply notification email sent for lead ${lead.id}`, {
      messageId: info.messageId,
    });
    return true;
  } catch (error) {
    logger.error("Failed to send email notification", { error: error.message });
    return false;
  }
}

/**
 * Perform a fuzzy match against the leads database using sender name.
 */
function matchLead(senderName, platform) {
  if (!senderName) return null;
  const db = getDb();

  // Clean names for matching
  const cleanSender = senderName.trim().toLowerCase();

  // In a real scenario, this matching would be more sophisticated (e.g. Levinshtein distance)
  // For this prototype, we'll look for exact partial matches on active leads
  const activeLeads = db
    .prepare(
      `
    SELECT * FROM leads 
    WHERE platform = ? AND status IN ('messaged', 'replied')
  `,
    )
    .all(platform);

  for (const lead of activeLeads) {
    if (!lead.name) continue;
    const cleanLead = lead.name.trim().toLowerCase();

    if (cleanSender.includes(cleanLead) || cleanLead.includes(cleanSender)) {
      return lead;
    }
  }

  return null;
}

async function closeBrowserState(browserState, platform) {
  if (!browserState) return;
  await closeBrowser(browserState.browser, platform, browserState.context, {
    mode: browserState.mode,
    tracePath: browserState.tracePath,
    shouldCloseBrowser: browserState.shouldCloseBrowser,
    lock: browserState.lock,
  });
}

async function firstText(locator, selectors, timeout = 800) {
  for (const selector of selectors) {
    try {
      const text = await locator
        .locator(selector)
        .first()
        .innerText({ timeout });
      if (text && text.trim()) return text.trim();
    } catch (_) {
      // Try the next selector.
    }
  }
  return "";
}

async function isLinkedInConversationUnread(convo) {
  const unreadSelectors = [
    ".msg-conversation-card__unread-count",
    '[class*="unread-count"]',
    '[aria-label*="unread"]',
    '[data-test-icon="unread"]',
  ];

  for (const selector of unreadSelectors) {
    if (
      await convo
        .locator(selector)
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false)
    ) {
      return true;
    }
  }

  const aria = await convo.getAttribute("aria-label").catch(() => "");
  const className = await convo.getAttribute("class").catch(() => "");
  return /unread/i.test(`${aria || ""} ${className || ""}`);
}

async function readLinkedInUnreadConversations(page, emit) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page
    .locator("body")
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});

  const conversationSelectors = [
    "li.msg-conversation-listitem",
    ".msg-conversation-listitem",
    '[data-view-name="message-list-item"]',
    '[role="listitem"]:has(a[href*="/messaging/thread/"])',
    'a[href*="/messaging/thread/"]',
  ];

  let conversations = null;
  for (const selector of conversationSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      conversations = locator;
      emit("debug", `LinkedIn reply detector using selector: ${selector}`);
      break;
    }
  }

  if (!conversations) {
    emit("info", "LinkedIn inbox loaded, but no conversation rows were found.");
    return [];
  }

  const unreadConversations = [];
  const count = Math.min(await conversations.count(), 30);

  for (let i = 0; i < count; i++) {
    const convo = conversations.nth(i);
    if (!(await isLinkedInConversationUnread(convo))) continue;

    const sender = await firstText(convo, [
      ".msg-conversation-listitem__participant-names",
      ".msg-conversation-card__participant-names",
      '[class*="participant"]',
      '[data-anonymize="person-name"]',
      "h3",
      'span[dir="ltr"]',
    ]);

    const text = await firstText(convo, [
      ".msg-conversation-card__message-snippet-body",
      '[class*="message-snippet"]',
      ".msg-conversation-listitem__message-snippet",
      "p",
      'span[aria-hidden="true"]',
    ]);

    if (sender || text) {
      unreadConversations.push({
        sender: sender || "Unknown sender",
        text: text || "(No preview available)",
      });
    }
  }

  return unreadConversations;
}

/**
 * Use Playwright to scan the inbox for unread messages on a specific platform.
 */
async function detectReplies(platform, emit = () => {}, browserOptions = {}) {
  let repliesFound = 0;

  if (!isSessionValid(platform)) {
    emit("warn", `No valid session for ${platform}. Skipping reply detection.`);
    return { repliesFound };
  }

  const inboxUrl = INBOX_URLS[platform];
  if (!inboxUrl) {
    emit("warn", `Inbox URL not configured for ${platform}.`);
    return { repliesFound };
  }

  emit("info", `Checking ${platform} inbox for replies...`);

  let browserState = null;
  const db = getDb();

  try {
    browserState = await createBrowser(platform, browserOptions);
    const { page } = browserState;

    await page.goto(inboxUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 6000);

    if (await checkSessionExpired(page, platform, emit)) {
      emit(
        "warn",
        `${platform} session needs manual attention. Reply detection paused.`,
      );
      return { repliesFound };
    }

    if (await detectCaptcha(page)) {
      emit("captcha", `CAPTCHA detected on ${platform} inbox.`);
      return { repliesFound };
    }

    // This section contains pseudo-selectors tailored per platform.
    // In production, these selectors require frequent updates.
    let unreadConversations = [];

    if (platform === "linkedin") {
      unreadConversations = await readLinkedInUnreadConversations(page, emit);
    } else if (platform === "x") {
      // Look for X conversations with unread indicator
      const convos = page.locator('[data-testid="conversation"]');
      const count = await convos.count();

      for (let i = 0; i < count; i++) {
        const convo = convos.nth(i);
        // Checking for unread dot
        const isUnread =
          (await convo.locator('[aria-label*="unread"]').count()) > 0;
        if (isUnread) {
          const nameText = await convo
            .locator('[data-testid="ConversationName"]')
            .innerText();
          const snippetText = await convo
            .locator('[data-testid="TweetTextSize_normal"]')
            .innerText();
          unreadConversations.push({ sender: nameText, text: snippetText });
        }
      }
    } else {
      // Stub for Instagram/Facebook
      emit("info", `${platform} selector logic stub executed.`);
    }

    emit(
      "info",
      `Found ${unreadConversations.length} unread conversations on ${platform}.`,
    );

    for (const convo of unreadConversations) {
      const lead = matchLead(convo.sender, platform);

      if (lead) {
        emit("info", `Matched reply from ${lead.name}! Updating CRM...`);

        // 1. Log Touchpoint
        db.prepare(
          `
          INSERT INTO touchpoints (lead_id, type, platform, outcome, notes)
          VALUES (?, 'reply', ?, 'received', ?)
        `,
        ).run(lead.id, platform, convo.text);

        // 2. Update Lead Status
        db.prepare(
          `
          UPDATE leads 
          SET status = 'replied', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        ).run(lead.id);

        // 3. Send Notification Email
        await sendEmailNotification(lead, convo.text);

        repliesFound++;
      } else {
        emit(
          "warn",
          `Unread message from ${convo.sender} did not match any active leads.`,
        );
      }
    }
  } catch (error) {
    logger.error(`Error detecting replies for ${platform}`, {
      error: error.message,
    });
    emit("error", `Detection error on ${platform}: ${error.message}`);
    if (browserState && browserState.page) {
      await captureFailureArtifact(
        browserState.page,
        platform,
        `reply-detection-${platform}`,
      );
    }
  } finally {
    await closeBrowserState(browserState, platform);
  }

  return { repliesFound };
}

module.exports = {
  detectReplies,
  sendEmailNotification,
};

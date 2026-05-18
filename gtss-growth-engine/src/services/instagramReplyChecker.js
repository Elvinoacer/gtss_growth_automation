const nodemailer = require("nodemailer");
const { getDb } = require("../db/database");
const {
  createInstagramBrowser,
  dailySessionWarmup,
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
} = require("../automation/browserBase");
const logger = require("../utils/logger");

/**
 * Configure Nodemailer transporter using GMAIL credentials from .env
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
 * Send a beautiful premium HTML email alert for a newly detected Instagram reply.
 *
 * @param {Object} lead - The lead database row object.
 * @param {string} replyText - The body text of the reply.
 * @param {string} source - The source type ('primary_inbox' or 'message_requests').
 * @returns {Promise<boolean>} Whether the email notification succeeded.
 */
async function sendReplyEmail(lead, replyText, source) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    logger.warn(
      "INSTAGRAM_REPLY_CHECKER",
      "GMAIL credentials not configured in environmental settings. Skipping reply email."
    );
    return false;
  }

  try {
    const transporter = createTransporter();
    const previewText =
      replyText.substring(0, 200) + (replyText.length > 200 ? "..." : "");

    const mailOptions = {
      from: `"GTSS Growth Engine" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `[Instagram Reply] New message from @${lead.ig_username || lead.name}`,
      html: `
        <div style="font-family: 'Outfit', 'Inter', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);">
          <h2 style="color: #ec4899; margin-top: 0; font-size: 24px; border-bottom: 2px solid #334155; padding-bottom: 12px;">📬 Instagram Reply Detected</h2>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 600; width: 120px;">Username:</td>
              <td style="padding: 8px 0; color: #f8fafc;">@${lead.ig_username || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 600;">Name:</td>
              <td style="padding: 8px 0; color: #f8fafc;">${lead.name || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 600;">Company:</td>
              <td style="padding: 8px 0; color: #f8fafc;">${lead.company || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 600;">Lead Score:</td>
              <td style="padding: 8px 0; color: #f59e0b; font-weight: bold;">${lead.lead_score !== null && lead.lead_score !== undefined ? lead.lead_score : "Unscored"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 600;">Source Type:</td>
              <td style="padding: 8px 0; color: #38bdf8; text-transform: uppercase; font-size: 11px; font-weight: bold; letter-spacing: 0.05em;">${source.replace(/_/g, " ")}</td>
            </tr>
          </table>

          <div style="background-color: #1e293b; padding: 20px; border-left: 4px solid #ec4899; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0; color: #94a3b8; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Message Snippet (First 200 Chars)</p>
            <blockquote style="margin: 8px 0 0 0; color: #f8fafc; font-style: italic; line-height: 1.6; font-size: 15px;">
              "${previewText}"
            </blockquote>
          </div>

          <div style="text-align: center; margin-top: 30px;">
            <a href="http://localhost:3000/crm?lead=${lead.id}" style="display: inline-block; background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; box-shadow: 0 4px 12px rgba(236, 72, 153, 0.3);">View Lead in CRM</a>
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Reply email alert sent successfully for lead ID ${lead.id}`
    );
    return true;
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      `Failed to send email alert for lead ID ${lead.id}`,
      err
    );
    return false;
  }
}

/**
 * Handle database log recording and trigger email dispatch for a lead reply.
 *
 * @param {number} leadId - The lead database ID.
 * @param {string} replyText - The reply content text.
 * @param {string} source - The source flow ('primary_inbox' or 'message_requests').
 */
async function updateLeadReply(leadId, replyText, source) {
  const db = getDb();

  // 1. Insert into touchpoints mapping source & timestamps
  db.prepare(
    `
    INSERT INTO touchpoints (lead_id, type, platform, notes, source, sent_at, created_at)
    VALUES (?, 'reply', 'instagram', ?, ?, datetime('now'), datetime('now'))
  `
  ).run(leadId, replyText, source);

  // 2. Transition lead record status and update timestamps
  db.prepare(
    `
    UPDATE leads
    SET status = 'replied', replied_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(leadId);

  // Retrieve full lead info for alert dispatching
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) {
    logger.warn(
      "INSTAGRAM_REPLY_CHECKER",
      `Lead ID ${leadId} not found in database for alert dispatching.`
    );
    return;
  }

  // 3. Dispatch Nodemailer HTML alert
  await sendReplyEmail(lead, replyText, source);
}

/**
 * Check the Primary Inbox page for unread threads from tracked leads.
 *
 * @param {Object} page - Playwright page context.
 */
async function checkPrimaryInbox(page) {
  const db = getDb();
  logger.info("INSTAGRAM_REPLY_CHECKER", "Navigating to Instagram Primary Inbox...");
  await page.goto("https://www.instagram.com/direct/inbox/", {
    waitUntil: "domcontentloaded",
  });
  await humanDelay(3000, 6000);

  // Locate listitems having bold titles or unread classes
  const unreadSelector =
    'div[role="listitem"]:has(span[style*="font-weight: bold"]), div[role="listitem"]:has(span[style*="font-weight: 600"]), div[role="listitem"]:has(.unread-indicator)';
  const unreadThreads = page.locator(unreadSelector);
  const count = await unreadThreads.count().catch(() => 0);

  logger.info("INSTAGRAM_REPLY_CHECKER", `Detected ${count} unread threads.`);

  for (let i = 0; i < count; i++) {
    const thread = unreadThreads.nth(i);

    // Extract sender username
    let username = "";
    const boldSpan = thread
      .locator('span[style*="font-weight: bold"], span[style*="font-weight: 600"]')
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
        `Skipping index ${i} thread: failed to extract username`
      );
      continue;
    }

    // Lookup lead
    const lead = db
      .prepare(
        "SELECT * FROM leads WHERE ig_username = ? AND platform = 'instagram'"
      )
      .get(cleanUsername);
    if (!lead) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        `Unread thread from non-tracked profile @${cleanUsername}. Skipping.`
      );
      continue;
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Tracked lead @${cleanUsername} has unread messages. Loading thread...`
    );
    await thread.click();
    await humanDelay(2000, 4000);

    // Read the last message
    const messages = page.locator(
      'div[role="row"], div[class*="message"], div[class*="bubble"]'
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
      `Extracted message content from @${cleanUsername}: "${replyText.substring(0, 45)}..."`
    );
    await updateLeadReply(lead.id, replyText, "primary_inbox");

    // Return to direct/inbox to refresh unread lists
    await page.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);
  }
}

/**
 * Scan the Direct Requests page, checking and accepting messages from tracked leads.
 *
 * @param {Object} page - Playwright page context.
 */
async function checkMessageRequests(page) {
  const db = getDb();
  logger.info("INSTAGRAM_REPLY_CHECKER", "Navigating to Message Requests page...");
  await page.goto("https://www.instagram.com/direct/requests/", {
    waitUntil: "domcontentloaded",
  });
  await humanDelay(3000, 6000);

  const requestThreads = page.locator('div[role="listitem"], a[href*="/direct/t/"]');
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
        "SELECT * FROM leads WHERE ig_username = ? AND platform = 'instagram'"
      )
      .get(cleanUsername);
    if (!lead) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        `Request from non-tracked profile @${cleanUsername}. Skipping.`
      );
      continue;
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Tracked lead @${cleanUsername} sent message request. Click thread...`
    );
    await thread.click();
    await humanDelay(2000, 4000);

    // Read the last request message content
    const messages = page.locator(
      'div[role="row"], div[class*="message"], div[class*="bubble"]'
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
    ];

    let accepted = false;
    for (const sel of acceptSelectors) {
      const btn = page.locator(sel);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
        await btn.first().click();
        await humanDelay(1500, 3000);

        // Handle nested dialog accept confirmation if any
        const confirmAccept = page
          .locator('button:has-text("Accept"), div[role="dialog"] button:has-text("Accept")')
          .first();
        if ((await confirmAccept.count()) > 0 && (await confirmAccept.isVisible())) {
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
        `Successfully accepted message request from @${cleanUsername}`
      );
    } else {
      logger.warn(
        "INSTAGRAM_REPLY_CHECKER",
        `Could not find Accept button for request from @${cleanUsername}`
      );
    }

    // Go back to Requests listing page
    await page.goto("https://www.instagram.com/direct/requests/", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(3000, 5000);
  }
}

/**
 * Coordinate and run both Inbox and Message Request scans.
 *
 * @returns {Promise<Object>} Execution status outcome.
 */
async function checkInbox() {
  logger.info("INSTAGRAM_REPLY_CHECKER", "Initializing inbox reply scan...");
  let browserState = null;
  try {
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    // Simulate natural session warmups
    await dailySessionWarmup(page);

    // 1. Check Primary Inbox
    await checkPrimaryInbox(page);

    // 2. Check Message Requests
    await checkMessageRequests(page);

    return { success: true };
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      "Fatal exception during automated inbox scanning",
      err
    );
    throw err;
  } finally {
    if (browserState) {
      const { closeBrowser } = require("../automation/browserBase");
      await closeBrowser(
        browserState.browser,
        "instagram",
        browserState.context,
        {
          mode: browserState.mode,
          tracePath: browserState.tracePath,
          shouldCloseBrowser: browserState.shouldCloseBrowser,
          lock: browserState.lock,
        }
      );
    }
  }
}

/**
 * Identify and track accounts that followed back.
 *
 * @returns {Promise<Object>} Summary metrics.
 */
async function checkFollowBacks() {
  const db = getDb();
  logger.info("INSTAGRAM_REPLY_CHECKER", "Initializing checkFollowBacks scan...");

  let browserState = null;
  try {
    browserState = await createInstagramBrowser();
    const page = browserState.page;

    // Natural session warmup
    await dailySessionWarmup(page);

    // Navigate to homepage
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // Extract own profile username
    let myUsername = "";
    const profileLink = page
      .locator(
        'a[href*="/"][role="link"]:has(svg[aria-label="Profile"]), a[href*="/"]:has-text("Profile")'
      )
      .first();
    let href = await profileLink.getAttribute("href").catch(() => "");
    if (href) {
      myUsername = href.replace(/\//g, "").trim().split("?")[0];
    }

    if (!myUsername) {
      // Fallback: sidebar link checks
      const sidebarProfileImage = page.locator('a[href*="/"]:has(img)').first();
      let fallbackHref = await sidebarProfileImage.getAttribute("href").catch(() => "");
      if (fallbackHref) {
        myUsername = fallbackHref.replace(/\//g, "").trim().split("?")[0];
      }
    }

    if (!myUsername) {
      // Manual click navigation checks
      const profileButton = page
        .locator('svg[aria-label="Profile"], a[href*="/"][role="link"]:has-text("Profile")')
        .first();
      if ((await profileButton.count()) > 0) {
        await profileButton.click();
        await humanDelay(4000, 7000);
        const match = page.url().match(/instagram\.com\/([a-zA-Z0-9_\.]+)\/?/);
        if (match) {
          myUsername = match[1];
        }
      }
    }

    if (!myUsername) {
      logger.error(
        "INSTAGRAM_REPLY_CHECKER",
        "Could not detect own Instagram username. Aborting checks."
      );
      return { success: false, error: "my_username_not_found" };
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Detected active username @${myUsername}. Loading followers list...`
    );

    // Navigate to profile followers tab directly
    await page.goto(`https://www.instagram.com/${myUsername}/followers/`, {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(4000, 7000);

    // Scroll list container
    const scrollableContainer = page
      .locator(
        'div[role="dialog"] div[style*="overflow-y"], div[role="dialog"] ul, div[role="dialog"] ._is12'
      )
      .first();
    if ((await scrollableContainer.count()) > 0) {
      logger.info(
        "INSTAGRAM_REPLY_CHECKER",
        "Scrolling followers container to lazy load entries..."
      );
      for (let s = 0; s < 3; s++) {
        await scrollableContainer.evaluate((el) => el.scrollBy(0, 500));
        await humanDelay(1500, 3000);
      }
    }

    // Gather anchor links
    const followerLinks = page.locator('div[role="dialog"] a[href]');
    const count = await followerLinks.count().catch(() => 0);
    const followerUsernames = new Set();

    for (let i = 0; i < count; i++) {
      const linkHref = await followerLinks.nth(i).getAttribute("href").catch(() => "");
      if (linkHref) {
        const username = linkHref.replace(/\//g, "").trim().split("?")[0];
        if (
          username &&
          username !== myUsername &&
          ![
            "about",
            "help",
            "press",
            "api",
            "jobs",
            "privacy",
            "terms",
            "explore",
            "direct",
            "emails",
            "accounts",
          ].includes(username)
        ) {
          followerUsernames.add(username);
        }
      }
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Discovered ${followerUsernames.size} loaded followers.`
    );

    let updatedCount = 0;
    const usernamesArray = Array.from(followerUsernames);

    for (const username of usernamesArray) {
      // Update follow tracker
      const trackerRes = db
        .prepare(
          `
        UPDATE ig_follow_tracker
        SET follow_back_at = datetime('now')
        WHERE username = ? AND follow_back_at IS NULL
      `
        )
        .run(username);

      // Update leads table ig_follow_back_at
      const leadsRes = db
        .prepare(
          `
        UPDATE leads
        SET ig_follow_back_at = datetime('now')
        WHERE ig_username = ? AND ig_follow_back_at IS NULL
      `
        )
        .run(username);

      if (trackerRes.changes > 0 || leadsRes.changes > 0) {
        logger.info(
          "INSTAGRAM_REPLY_CHECKER",
          `Recorded follow-back state for lead @${username}`
        );
        updatedCount++;
      }
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Follow-back checks successfully completed. Marked ${updatedCount} profiles.`
    );
    return { success: true, newFollowBacksCount: updatedCount };
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      "Fatal exception during checkFollowBacks scanning",
      err
    );
    throw err;
  } finally {
    if (browserState) {
      const { closeBrowser } = require("../automation/browserBase");
      await closeBrowser(
        browserState.browser,
        "instagram",
        browserState.context,
        {
          mode: browserState.mode,
          tracePath: browserState.tracePath,
          shouldCloseBrowser: browserState.shouldCloseBrowser,
          lock: browserState.lock,
        }
      );
    }
  }
}

module.exports = {
  updateLeadReply,
  checkPrimaryInbox,
  checkMessageRequests,
  checkInbox,
  checkFollowBacks,
};

/**
 * instagramReplyChecker/notifications.js — outbound alert delivery.
 *
 * Owns the two notification channels that fire when a tracked lead replies
 * on Instagram: a premium HTML email (via Nodemailer + Gmail) and a Slack
 * incoming-webhook block payload. Both channels are best-effort and log +
 * swallow their own errors so a flaky channel never blocks the reply
 * touchpoint recording.
 *
 * Extracted from the original instagramReplyChecker.js for maintainability.
 */

const nodemailer = require("nodemailer");
const { getContext } = require("../contextService");
const logger = require("../../utils/logger");

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
      "GMAIL credentials not configured in environmental settings. Skipping reply email.",
    );
    return false;
  }

  try {
    const transporter = createTransporter();
    const previewText =
      replyText.substring(0, 200) + (replyText.length > 200 ? "..." : "");
    const ctx = getContext();

    const mailOptions = {
      from: `"${ctx.ctx_biz_name} Growth Engine" <${process.env.GMAIL_USER}>`,
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
      `Reply email alert sent successfully for lead ID ${lead.id}`,
    );
    return true;
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      `Failed to send email alert for lead ID ${lead.id}`,
      err,
    );
    return false;
  }
}

/**
 * Send a beautiful premium Slack alert to the configured webhook channel.
 *
 * @param {Object} lead - The lead database row object.
 * @param {string} replyText - The body text of the reply.
 * @param {string} source - The source type.
 * @returns {Promise<boolean>} Whether the Slack notification succeeded.
 */
async function sendSlackNotification(lead, replyText, source) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.debug(
      "INSTAGRAM_REPLY_CHECKER",
      "SLACK_WEBHOOK_URL not configured. Skipping Slack alert.",
    );
    return false;
  }

  try {
    const previewText =
      replyText.substring(0, 200) + (replyText.length > 200 ? "..." : "");

    const payload = {
      text: `📬 *Instagram Reply Detected* from @${lead.ig_username || lead.name}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📬 Instagram Reply Detected",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Username:*\n@${lead.ig_username || "N/A"}`,
            },
            {
              type: "mrkdwn",
              text: `*Name:*\n${lead.name || "N/A"}`,
            },
            {
              type: "mrkdwn",
              text: `*Company:*\n${lead.company || "N/A"}`,
            },
            {
              type: "mrkdwn",
              text: `*Lead Score:*\n*${lead.lead_score !== null && lead.lead_score !== undefined ? lead.lead_score : "Unscored"}*`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Source Type:*\n\`${source.toUpperCase().replace(/_/g, " ")}\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Message Snippet:*\n> "${previewText}"`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "View Lead in CRM",
                emoji: true,
              },
              url: `http://localhost:3000/crm?lead=${lead.id}`,
              style: "primary",
            },
          ],
        },
      ],
    };

    if (typeof fetch === "function") {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          `Slack webhook responded with status ${response.status}`,
        );
      }
    } else {
      const https = require("https");
      const url = new URL(webhookUrl);
      const postData = JSON.stringify(payload);

      await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(postData),
            },
          },
          (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(
                new Error(
                  `Slack webhook responded with status ${res.statusCode}`,
                ),
              );
            }
          },
        );

        req.on("error", (err) => reject(err));
        req.write(postData);
        req.end();
      });
    }

    logger.info(
      "INSTAGRAM_REPLY_CHECKER",
      `Slack alert sent successfully for lead ID ${lead.id}`,
    );
    return true;
  } catch (err) {
    logger.error(
      "INSTAGRAM_REPLY_CHECKER",
      `Failed to send Slack alert for lead ID ${lead.id}`,
      err,
    );
    return false;
  }
}

module.exports = {
  createTransporter,
  sendReplyEmail,
  sendSlackNotification,
};

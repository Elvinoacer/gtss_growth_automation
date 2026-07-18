/**
 * Instagram Direct Message (sendDM)
 * Sends a DM to a target Instagram user via a state-machine flow:
 * NAVIGATE -> DETECT_THREAD -> INSPECT_THREAD -> CREATE_NEW_THREAD ->
 * TYPE_MESSAGE -> CLICK_SEND -> AWAIT_CONFIRMATION_OR_DELIVERY -> CONFIRM_REQUEST.
 * Handles login state checks, composer opening, text input, send-button
 * detection, message-request confirmation, and delivery verification.
 * Extracted from the original instagram.js for maintainability.
 */

const {
  humanDelay,
  firstVisible,
  humanMouseMove,
  isInstagramBlocked,
} = require("../browserBase");
const { getDb } = require("../../db/database");
const logger = require("../../utils/logger");
const { normalizeInstagramUsername } = require("../../utils/instagramUsername");

const { igDelay, safeEmit } = require("./emitter");
const {
  verifyDelivery,
  normalizeEditableText,
  getEditableText,
  setComposerTextWithDomEvents,
} = require("./dmEditor");

async function sendDM(page, { username, message }, emitter) {
  // Cold-DM gate: off by default until re-enabled in Settings.
  try {
    const { isIgDmOutreachEnabled } = require("../../config/pipelineConfig");
    if (!isIgDmOutreachEnabled()) {
      const reason =
        "Instagram DM outreach is disabled. Enable it under Settings → Pipeline Configuration when ready for paced IG DMs.";
      safeEmit(emitter, "warn", reason);
      return { success: false, error: "ig_dm_outreach_disabled", reason };
    }
  } catch (_) {
    // If config cannot load, fail closed for cold DM automation.
    return { success: false, error: "ig_dm_outreach_disabled" };
  }

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
  let threadUrl = "";

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

    let state = "NAVIGATE";
    let iterations = 0;
    const maxIterations = 20;

    while (
      state !== "SUCCESS" &&
      state !== "SKIP_DUPLICATE" &&
      state !== "SKIP_REPLY" &&
      iterations < maxIterations
    ) {
      iterations++;
      safeEmit(emitter, "info", `[DM_STATE_MACHINE] State: ${state}`);

      switch (state) {
        case "NAVIGATE": {
          safeEmit(
            emitter,
            "info",
            `Navigating to Instagram inbox to check for existing thread with @${resolvedUsername}`,
          );
          await page.goto("https://www.instagram.com/direct/inbox/", {
            waitUntil: "domcontentloaded",
          });
          await humanDelay(3000, 5000);
          state = "DETECT_THREAD";
          break;
        }

        case "DETECT_THREAD": {
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

          if (inboxSearchInput) {
            await inboxSearchInput.fill(""); // Clear
            await humanDelay(300, 700);
            const { humanTypeText } = require("../browserBase");
            await humanTypeText(page, inboxSearchInput, resolvedUsername);
            await humanDelay(2000, 3000); // Wait for typeahead results

            // Look for a filtered thread list item containing username (inbox scoped)
            const threadItem = await firstVisible(
              page,
              [
                `div[role="list"] a[href*="/direct/t/"]:has-text("${resolvedUsername}")`,
                `a[href*="/direct/t/"]:has-text("${resolvedUsername}")`,
                `div[role="button"]:has-text("${resolvedUsername}")`,
              ],
              4000,
            ).catch(() => null);

            if (threadItem) {
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
              state = "INSPECT_THREAD";
            } else {
              safeEmit(
                emitter,
                "info",
                `No existing thread found for @${resolvedUsername} in inbox.`,
              );
              state = "CREATE_NEW_THREAD";
            }
          } else {
            safeEmit(
              emitter,
              "warning",
              "Inbox search input not found. Proceeding directly to create new thread.",
            );
            state = "CREATE_NEW_THREAD";
          }
          break;
        }

        case "INSPECT_THREAD": {
          // Check if there are messages and who sent the last one
          const messages = page.locator(
            'div[role="row"], div[class*="message"], div[class*="bubble"]',
          );
          const msgCount = await messages.count().catch(() => 0);
          let lastMessageSentByUs = false;
          let theyReplied = false;

          if (msgCount > 0) {
            const lastMsg = messages.last();
            const alignStr =
              (await lastMsg.getAttribute("style").catch(() => "")) || "";
            const classStr =
              (await lastMsg.getAttribute("class").catch(() => "")) || "";
            const alignSelf = await lastMsg
              .evaluate((el) => {
                const style = window.getComputedStyle(el);
                return (
                  style.justifyContent ||
                  style.alignItems ||
                  style.alignSelf ||
                  ""
                );
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

          if (lastMessageSentByUs) {
            state = "SKIP_DUPLICATE";
          } else if (theyReplied) {
            state = "SKIP_REPLY";
          } else {
            state = "TYPE_MESSAGE";
          }
          break;
        }

        case "CREATE_NEW_THREAD": {
          safeEmit(
            emitter,
            "info",
            `Opening DM composer for @${resolvedUsername}`,
          );
          // Remove fragile SVG click targets; use text button/link or container
          const newMsgBtn = await firstVisible(
            page,
            [
              'a[href*="/direct/new/"]',
              'div[role="button"]:has-text("New message")',
              'div[role="button"]:has-text("New Message")',
              'button[aria-label="New Message"]',
              'div[role="button"]:has(svg[aria-label="New message"])',
              'div[role="button"]:has(svg[aria-label="New Message"])',
              'svg[aria-label="New message"]',
              'svg[aria-label="New Message"]',
            ],
            5000,
          );

          if (!newMsgBtn) {
            throw new Error("New Message button/link not found");
          }

          await humanMouseMove(page, newMsgBtn);
          await humanDelay(300, 700);
          await newMsgBtn.click();
          await humanDelay(1500, 2500);

          // Wait for recipient search input (scoped inside the dialog if present)
          const searchField = await firstVisible(
            page,
            [
              'div[role="dialog"] input[name="query"]',
              'div[role="dialog"] input[placeholder*="Search..."]',
              'input[name="query"]',
              'input[placeholder*="Search..."]',
            ],
            5000,
          );

          if (!searchField) {
            throw new Error("Recipient search field not found");
          }

          const { humanTypeText } = require("../browserBase");
          await humanTypeText(page, searchField, resolvedUsername);
          await humanDelay(2000, 3000); // Wait for typeahead results

          // Exact username match check, dialog-scoped
          const results = page.locator(
            `div[role="dialog"] span:has-text("${resolvedUsername}"), div[role="dialog"] div:has-text("${resolvedUsername}")`,
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
            throw new Error("recipient_not_found");
          }

          await humanMouseMove(page, exactResult);
          await humanDelay(300, 600);
          await exactResult.click();
          await humanDelay(1000, 2000);

          // Click next button, dialog-scoped
          const nextBtn = await firstVisible(
            page,
            [
              'div[role="dialog"] button:has-text("Next")',
              'button:has-text("Next")',
              'div[role="button"]:has-text("Next")',
            ],
            5000,
          );

          if (!nextBtn) {
            throw new Error("Next button not found");
          }

          await humanMouseMove(page, nextBtn);
          await humanDelay(300, 600);
          await nextBtn.click();
          await humanDelay(1500, 2500);

          state = "TYPE_MESSAGE";
          break;
        }

        case "TYPE_MESSAGE": {
          // Wait for DM composer to appear (timeout 10s)
          const composerElement = await firstVisible(
            page,
            [
              'div[role="textbox"][contenteditable="true"]',
              'textarea[placeholder*="Message..."]',
              'div[aria-label*="Message" i]',
            ],
            10000,
          ).catch(() => null);

          if (!composerElement) {
            throw new Error("composer_timeout");
          }

          // Type message
          safeEmit(emitter, "info", "Composer ready — typing message");
          const { humanTypeText } = require("../browserBase");
          await humanTypeText(page, composerElement, message);
          await humanDelay(2000, 4000); // Simulate reading/reviewing

          // Verify text is present in composer (harden against UI rendering lag)
          let composerText = normalizeEditableText(
            await getEditableText(composerElement),
          );
          const expectedMessage = normalizeEditableText(message);
          let backupWriteOk = false;
          if (!composerText.includes(expectedMessage)) {
            safeEmit(
              emitter,
              "warning",
              "Composer text did not match the outgoing message. Attempting backup write.",
            );
            backupWriteOk = await setComposerTextWithDomEvents(
              composerElement,
              message,
            );
            await humanDelay(1000, 2000);
            composerText = normalizeEditableText(
              await getEditableText(composerElement),
            );
          }

          if (!composerText.includes(expectedMessage) && !backupWriteOk) {
            throw new Error(
              "Typed message missing from Instagram composer before send",
            );
          }

          state = "CLICK_SEND";
          break;
        }

        case "CLICK_SEND": {
          // Click DM Send button
          const sendBtn = await firstVisible(
            page,
            [
              'button:has-text("Send")',
              'div[role="button"]:has-text("Send")',
              'button:has(svg[aria-label="Send"])',
            ],
            5000,
          ).catch(() => null);

          if (!sendBtn) {
            throw new Error("send_button_not_found");
          }

          await humanMouseMove(page, sendBtn);
          await humanDelay(300, 600);
          await sendBtn.click();

          state = "AWAIT_CONFIRMATION_OR_DELIVERY";
          break;
        }

        case "AWAIT_CONFIRMATION_OR_DELIVERY": {
          // Wait a moment for either delivery or the message request confirmation popup to render
          await humanDelay(2000, 3000);

          // Check for message request dialog (MUST occur AFTER clicking Send)
          const dialogBtn = await firstVisible(
            page,
            [
              'button:has-text("Send Message Request")',
              'button:has-text("Send anyway")',
              'span:has-text("Send Message Request")',
              'span:has-text("Send anyway")',
              'div[role="dialog"] button:has-text("Send Message Request")',
              'div[role="dialog"] button:has-text("Send anyway")',
            ],
            1500, // Small check window
          ).catch(() => null);

          if (dialogBtn) {
            safeEmit(
              emitter,
              "info",
              "Message request confirmation dialog detected. Transitioning to CONFIRM_REQUEST.",
            );
            state = "CONFIRM_REQUEST";
          } else {
            // Verify delivery in DOM
            safeEmit(
              emitter,
              "info",
              "No confirmation dialog detected. Verifying message delivery...",
            );
            const delivered = await verifyDelivery(page, message);
            if (delivered) {
              state = "SUCCESS";
            } else {
              throw new Error(
                "Message delivery verification failed (message not found in chat log or compose box not cleared).",
              );
            }
            break;
          }
        }

        case "CONFIRM_REQUEST": {
          // We look for the dialog button again and click it
          const dialogBtn = await firstVisible(
            page,
            [
              'button:has-text("Send Message Request")',
              'button:has-text("Send anyway")',
              'span:has-text("Send Message Request")',
              'span:has-text("Send anyway")',
              'div[role="dialog"] button:has-text("Send Message Request")',
              'div[role="dialog"] button:has-text("Send anyway")',
            ],
            3000,
          ).catch(() => null);

          if (!dialogBtn) {
            await humanDelay(1500, 2500);
            throw new Error(
              "Confirmation dialog button vanished before clicking",
            );
          }

          safeEmit(emitter, "info", "Clicking send anyway/request button...");
          await humanMouseMove(page, dialogBtn);
          await humanDelay(300, 600);
          await dialogBtn.click();
          dialogWasShown = true;
          await humanDelay(2000, 3000);

          // Verify delivery in DOM after confirming
          const delivered = await verifyDelivery(page, message);
          if (delivered) {
            state = "SUCCESS";
          } else {
            // Try one more check
            await humanDelay(2000, 3000);
            const retryDelivered = await verifyDelivery(page, message);
            if (retryDelivered) {
              state = "SUCCESS";
            } else {
              throw new Error(
                "Message delivery verification failed after confirming message request.",
              );
            }
          }
          break;
        }
      }
    }

    if (iterations >= maxIterations) {
      throw new Error(
        "State machine exceeded maximum execution steps (possible loop).",
      );
    }

    if (state === "SKIP_DUPLICATE") {
      safeEmit(
        emitter,
        "skipped",
        `Already messaged @${username} (last message was sent by us)`,
      );
      return { success: false, error: "already_messaged", threadUrl };
    }

    if (state === "SKIP_REPLY") {
      safeEmit(
        emitter,
        "info",
        `@${username} has replied to us. Skipping re-send.`,
      );
      return { success: true, hadReply: true };
    }

    if (state === "SUCCESS") {
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
    }

    throw new Error(
      `State machine terminated in an invalid final state: ${state}`,
    );
  } catch (err) {
    logger.error("Instagram sendDM Failed", { username, error: err.message });
    safeEmit(emitter, "error", `Send DM failed: ${err.message}`);
    // Capture screenshot on error
    const { captureFailureArtifact } = require("../browserBase");
    if (captureFailureArtifact) {
      await captureFailureArtifact(
        page,
        "instagram",
        `sendDM-fail-${username}`,
      );
    }
    // Map composer_timeout / recipient_not_found to the exact string matching unit tests
    if (
      err.message === "composer_timeout" ||
      err.message.includes("composer_timeout")
    ) {
      return { success: false, error: "composer_timeout" };
    }
    if (
      err.message === "recipient_not_found" ||
      err.message.includes("recipient_not_found")
    ) {
      return { success: false, error: "recipient_not_found" };
    }
    return { success: false, error: err.message };
  } finally {
    // Guaranteed Nairobi delay 'betweenDMs'
    await igDelay("betweenDMs");
  }
}

module.exports = { sendDM };

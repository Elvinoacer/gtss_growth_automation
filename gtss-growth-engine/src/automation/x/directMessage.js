/**
 * x/directMessage.js
 *
 * sendDirectMessage(page, profileUrl, message, emit) — Send a Direct
 * Message on X (Twitter).
 *
 * Flow:
 *   1. Navigate to the profile URL + wait for the page to settle.
 *   2. Check the account status via checkAccountStatus — return early
 *      with `outcome: "failed"` if the account is suspended / doesn't exist.
 *   3. Locate the Message button via firstVisibleOnProfile — if not
 *      found, the user has DMs restricted; return
 *      `outcome: "not_connected"` with a clear reason.
 *   4. Click the Message button + wait 2-4s for the DM composer to load.
 *   5. Locate the DM composer via firstVisible (SELECTORS.dmComposer).
 *   6. Type the message character-by-character via typeLikeHuman (random
 *      inter-key delays to look human).
 *   7. ensureComposerContainsMessage — re-verify the typed text is
 *      actually present (X's contenteditable sometimes drops characters).
 *      Abort with `outcome: "failed"` if not.
 *   8. Locate the Send button via SELECTORS.dmSend. If disabled or
 *      missing, fall back to the Control+Enter keyboard shortcut.
 *   9. verifyDmSent — poll up to 8s for either the message snippet to
 *      appear in the thread OR the composer to clear. If a rate-limit
 *      toast appears during polling, return `outcome: "failed"` with the
 *      warning text. If polling ends ambiguously, return
 *      `outcome: "unknown"`.
 *
 * The `emit(type, message)` callback lets the caller stream live progress
 * events to its UI ("info" / "warn" / "error").
 *
 * Path notes: the original file used `require("./browserBase")` for
 * humanDelay — from this split file (one level deeper) that becomes
 * `require("../browserBase")`. The original `require("../utils/logger")`
 * becomes `require("../../utils/logger")` here.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const {
  checkAccountStatus,
  ensureComposerContainsMessage,
  firstVisible,
  firstVisibleOnProfile,
  typeLikeHuman,
  verifyDmSent,
} = require("./domHelpers");

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

    if (!(await ensureComposerContainsMessage(composerMatch.locator, message))) {
      emit("error", "Typed message is not present in the X DM composer. Aborting send.");
      return {
        outcome: "failed",
        reason: "Typed message missing from X composer before send",
      };
    }

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

module.exports = { sendDirectMessage };

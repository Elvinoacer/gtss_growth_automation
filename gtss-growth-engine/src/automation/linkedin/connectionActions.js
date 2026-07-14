/**
 * LinkedIn Connection Request
 * sendConnectionRequest — navigate to a profile, click Connect, optionally
 * attach a note, and click Send. Extracted from the original linkedin.js
 * for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const {
  firstVisible,
  firstVisibleIn,
  findProfileAction,
} = require("./profileActions");
const { firstVisibleOverlay } = require("./dmEditorDetection");
const { isAnyVisibleOnProfile, detectActionWarning } = require("./detection");
const { bringLinkedInPageToFront } = require("./focus");
const { typeIntoFirstVisibleIn } = require("./typing");

/**
 * Perform a LinkedIn connection request with an optional note.
 */
async function sendConnectionRequest(page, profileUrl, message, emit) {
  try {
    await bringLinkedInPageToFront(page);
    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(300, 650);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(100, 250);

    emit("info", "Page loaded. Locating Connect action...");

    const messageBtnVisible = Boolean(
      await findProfileAction(page, SELECTORS.message, "Message", 700),
    );
    const isPending = await isAnyVisibleOnProfile(page, SELECTORS.pending);

    if (isPending) {
      emit("warn", "Connection request is already pending.");
      return { outcome: "already_connected" };
    }

    let connectMatch = await findProfileAction(
      page,
      SELECTORS.connect,
      "Connect",
      1200,
    );

    // Sometimes Connect is hidden under a "More" menu
    if (!connectMatch) {
      emit(
        "info",
        "Connect action not immediately visible. Checking More menu...",
      );
      const moreMatch = await findProfileAction(
        page,
        SELECTORS.more,
        "More",
        800,
      );
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
    // DOM-level click: avoids sticky-header interception when element is near viewport top.
    await connectMatch.locator.evaluate((el) => el.click()).catch(() => {});
    await humanDelay(700, 1200);

    // If there's a message, look for "Add a note"
    if (message) {
      const modalMatch = await firstVisible(page, SELECTORS.modal, 3000);
      const addNoteMatch = modalMatch
        ? await firstVisibleIn(modalMatch.locator, SELECTORS.addNote, 2000)
        : null;
      if (addNoteMatch) {
        emit("info", "Adding connection note...");
        await addNoteMatch.locator.click();
        await humanDelay(500, 900);

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
        await humanDelay(500, 900);
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
      await humanDelay(700, 1400);

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

module.exports = { sendConnectionRequest };

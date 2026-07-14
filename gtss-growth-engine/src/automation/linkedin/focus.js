/**
 * LinkedIn Page Focus
 * Bring the LinkedIn tab to the OS foreground before any keyboard interaction.
 * Extracted from the original linkedin.js for maintainability.
 *
 * In CDP-connected sessions (chromium.connectOverCDP) LinkedIn runs in a
 * background tab. Chromium suppresses keyboard events and document.hasFocus()
 * returns false for non-focused tabs — React's SyntheticEvent system checks
 * this flag, so ALL key input is silently dropped until the tab is brought
 * to front. This mirrors the identical fix already present in instagram.js.
 */

const { humanDelay } = require("../browserBase");

/**
 * Bring the LinkedIn tab to the OS foreground before any keyboard interaction.
 *
 * Additionally, page.bringToFront() only activates the tab inside Chrome — it
 * does NOT guarantee the Chrome window itself has OS-level window focus. We
 * use the CDP Target.activateTarget command to bring the window to front, and
 * also override document.hasFocus() as a belt-and-suspenders fallback in case
 * the OS focus transfer is delayed or blocked (e.g. by a window manager).
 */
async function bringLinkedInPageToFront(page, messagingFrame = null) {
  if (page && typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});

    // CDP-level focus: use Target.activateTarget to bring Chrome window to OS front.
    // page.bringToFront() only switches the tab; this command tells Chrome to
    // raise the actual OS window, which is what makes document.hasFocus() true.
    try {
      const cdpSession = await page.context().newCDPSession(page);
      // Activate the target (brings window to front at OS level)
      const { targetInfo } = await cdpSession
        .send("Target.getTargetInfo")
        .catch(() => ({ targetInfo: null }));
      if (targetInfo?.targetId) {
        await cdpSession
          .send("Target.activateTarget", { targetId: targetInfo.targetId })
          .catch(() => {});
      }
      // Also focus the page explicitly through CDP
      await cdpSession.send("Page.bringToFront").catch(() => {});
      await cdpSession.detach().catch(() => {});
    } catch (_) {
      // CDP commands not available (non-CDP mode) — bringToFront() is enough
    }

    // Allow 200 ms for the OS to transfer window focus so document.hasFocus()
    // returns true before the first keyboard event fires.
    await humanDelay(150, 250);

    // Belt-and-suspenders: override document.hasFocus() to always return true.
    // In CDP mode, even after activating the target, some window managers or
    // compositors delay the focus grant. LinkedIn's React checks hasFocus()
    // on every keystroke — if it returns false, ALL keyboard input is silently
    // dropped. This override ensures typing always works regardless of OS focus.
    await page
      .evaluate(() => {
        if (!document._gtssHasFocusPatched) {
          document.hasFocus = () => true;
          document._gtssHasFocusPatched = true;
        }
      })
      .catch(() => {});

    // Also patch hasFocus() inside the messaging iframe if it's available.
    // The iframe has its own document context — its React compositor also
    // checks hasFocus() and will drop keyboard events if it returns false.
    if (messagingFrame) {
      await messagingFrame
        .evaluate(() => {
          if (!document._gtssHasFocusPatched) {
            document.hasFocus = () => true;
            document._gtssHasFocusPatched = true;
          }
        })
        .catch(() => {});
    }
  }
}

module.exports = { bringLinkedInPageToFront };

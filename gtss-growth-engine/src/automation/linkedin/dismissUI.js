/**
 * LinkedIn Messaging UI Dismissal
 * Functions for dismissing LinkedIn's top-nav dropdowns ("For Business" /
 * "My Apps") and any lingering messaging overlays/modals.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");

/**
 * Dismiss any open LinkedIn top-nav dropdowns — specifically the
 * "For Business" / "My Apps" nine-dot menu and the top-nav "More" menu.
 *
 * Why this exists:
 *   Users reported that the "My Apps" / "For Business" dropdown opens
 *   every time the automation fires. This is caused either by LinkedIn's
 *   own UI behaviour (auto-opening on navigation, hover-open menus, or
 *   React state surviving across page loads) or by an errant click during
 *   the DM flow. Regardless of the trigger, an open dropdown:
 *     - covers the Message button we need to click
 *     - intercepts keyboard events
 *     - leaves the UI in a confusing state for the user
 *
 * Strategy:
 *   1. Detect known dropdown containers by their content ("My Apps",
 *      "Explore more for business", "Hire on LinkedIn", "Sell with
 *      LinkedIn", etc.) — these strings only appear together in the
 *      For Business dropdown.
 *   2. If a dropdown is open, press Escape (the universal closer for
 *      LinkedIn's dropdowns) and also click any visible
 *      `aria-expanded="true"` trigger to toggle it closed.
 *   3. As a final fallback, click the document body at a safe location
 *      to blur any focused trigger.
 *
 * This is a NO-OP if no dropdown is open, so it is safe to call
 * repeatedly.
 */
async function dismissLinkedInNavDropdowns(page) {
  try {
    // Detection: look for the unique content of the For Business / My Apps
    // dropdown. These three strings only ever co-occur inside that menu.
    const dropdownOpen = await page
      .evaluate(() => {
        const allText = document.body
          ? (document.body.innerText || "").toLowerCase()
          : "";
        if (!allText) return false;
        const hasMyApps = /\bmy apps\b/.test(allText);
        const hasExploreBusiness = /explore more for business/.test(allText);
        const hasHireOnLinkedin = /hire on linkedin/.test(allText);
        // Also detect the top-nav "More" dropdown (Learning, Salary, etc.)
        // by checking for a visible [role="menu"] that is NOT inside a
        // messaging modal.
        const menus = Array.from(
          document.querySelectorAll('[role="menu"], .global-nav-dropdown, [data-control-name*="top_nav"]'),
        );
        const visibleTopNavMenu = menus.some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (
            rect.width < 50 ||
            rect.height < 50 ||
            style.display === "none" ||
            style.visibility === "hidden"
          ) {
            return false;
          }
          // Reject menus that live inside a messaging overlay/modal — those
          // are handled by dismissAllMessagingUI and should not be touched
          // here (doing so could close the composer we are trying to use).
          if (
            el.closest(
              '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-form,' +
                ' [role="dialog"], .artdeco-modal, #interop-outlet',
            )
          ) {
            return false;
          }
          // Top-nav menus live near the top of the viewport.
          return rect.top < 120;
        });
        return hasMyApps || hasExploreBusiness || hasHireOnLinkedin || visibleTopNavMenu;
      })
      .catch(() => false);

    if (!dropdownOpen) return false;

    // Close strategy 1: press Escape (LinkedIn's dropdowns all respond to it).
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape").catch(() => {});
      await humanDelay(80, 150);
      const stillOpen = await page
        .evaluate(() => {
          const allText = document.body
            ? (document.body.innerText || "").toLowerCase()
            : "";
          if (/explore more for business/.test(allText)) return true;
          if (/\bmy apps\b/.test(allText) && /hire on linkedin/.test(allText)) return true;
          const menus = Array.from(document.querySelectorAll('[role="menu"]'));
          return menus.some((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (
              rect.width < 50 ||
              rect.height < 50 ||
              style.display === "none" ||
              style.visibility === "hidden"
            ) {
              return false;
            }
            if (
              el.closest(
                '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-form,' +
                  ' [role="dialog"], .artdeco-modal, #interop-outlet',
              )
            ) {
              return false;
            }
            return rect.top < 120;
          });
        })
        .catch(() => false);
      if (!stillOpen) return true;
    }

    // Close strategy 2: toggle any aria-expanded="true" trigger in the
    // global nav back to closed.
    await page
      .evaluate(() => {
        const triggers = document.querySelectorAll(
          '.global-nav__nav-item [aria-expanded="true"],' +
            ' nav [aria-expanded="true"],' +
            ' header [aria-expanded="true"]',
        );
        triggers.forEach((el) => {
          try {
            el.click();
          } catch (_) {}
        });
      })
      .catch(() => {});
    await humanDelay(80, 150);

    // Close strategy 3: click on a neutral area of the page body to blur
    // any focused trigger.
    await page
      .evaluate(() => {
        const el = document.querySelector(
          '.core-rail, main, .scaffold-layout__main, #profile-content',
        );
        if (el) {
          try {
            el.click();
          } catch (_) {}
        }
      })
      .catch(() => {});

    return true;
  } catch (err) {
    logger.warn(`dismissLinkedInNavDropdowns failed: ${err.message}`);
    return false;
  }
}

/**
 * Dismiss ALL open messaging UI — overlays, chat windows, full-page messaging.
 *
 * LinkedIn's new UI uses obfuscated class names, so we use broad strategies:
 * 1. Press Escape repeatedly to dismiss modals/overlays
 * 2. Click close buttons using broad attribute-based selectors
 * 3. Clean up any stale data-gtss-* attributes from previous runs
 * 4. Dismiss any open top-nav "For Business" / "My Apps" dropdown
 *
 * Called before navigation to a new profile and in the finally block.
 */
async function dismissAllMessagingUI(page) {
  try {
    // Strategy 0: Close any open LinkedIn top-nav dropdowns first.
    // The "For Business" / "My Apps" menu can survive navigation and
    // intercept subsequent clicks. Dismiss it before doing anything else.
    await dismissLinkedInNavDropdowns(page);

    // Strategy 1: Press Escape up to 3 times to dismiss modals/overlays
    for (let i = 0; i < 3; i++) {
      const hasVisibleOverlay = await page
        .evaluate(() => {
          // Check for any visible messaging-like overlay
          const candidates = document.querySelectorAll(
            '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-form,' +
            ' [role="dialog"], .artdeco-modal, [data-gtss-active-overlay],' +
            ' [class*="msg-overlay"], [class*="messaging"]'
          );
          for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (
              rect.width > 100 &&
              rect.height > 100 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            ) {
              return true;
            }
          }
          return false;
        })
        .catch(() => false);

      if (!hasVisibleOverlay) break;

      await page.keyboard.press("Escape").catch(() => {});
      await humanDelay(150, 250);
    }

    // Strategy 2: Click close buttons using broad selectors
    const closeSelectors = [
      // LinkedIn's old class names
      '.msg-overlay-bubble-header__control--close',
      '.msg-overlay-conversation-bubble__close-btn',
      '[data-control-name="close_chat"]',
      // Broad attribute-based selectors for new UI
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      'button[aria-label="Close your conversation"]',
      'button[aria-label*="close" i]',
      'button[aria-label*="dismiss" i]',
    ];

    for (const sel of closeSelectors) {
      const buttons = page.locator(sel);
      const count = await buttons.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const btn = buttons.nth(i);
        if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
          await btn.click({ force: true }).catch(() => {});
          await humanDelay(100, 200);
        }
      }
    }

    // Strategy 3: Clean up stale data-gtss attributes
    await page
      .evaluate(() => {
        const attrs = [
          "data-gtss-active-overlay",
          "data-gtss-dm-editor",
          "data-gtss-dm-overlay",
          "data-gtss-container",
          "data-gtss-send",
        ];
        for (const attr of attrs) {
          document.querySelectorAll(`[${attr}]`).forEach((el) => {
            el.removeAttribute(attr);
          });
        }
      })
      .catch(() => {});
  } catch (err) {
    logger.warn(`dismissAllMessagingUI failed: ${err.message}`);
  }
}

module.exports = {
  dismissLinkedInNavDropdowns,
  dismissAllMessagingUI,
};

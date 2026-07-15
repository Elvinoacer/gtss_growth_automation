/**
 * LinkedIn Messaging UI Dismissal
 * Functions for dismissing LinkedIn's top-nav dropdowns ("For Business" /
 * "My Apps") and any lingering messaging overlays/modals.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");

/**
 * Detect whether the LinkedIn "For Business" / "My Apps" flyout is open.
 *
 * IMPORTANT: do NOT use document.body.innerText alone. Hidden nav markup and
 * marketing sidebars can contain "My Apps" / "Hire on LinkedIn" strings even
 * when the flyout is closed, which previously caused us to spam Escape and
 * toggle aria-expanded triggers — and sometimes OPEN the For Business panel.
 *
 * Detection is based on:
 *   1. button[aria-label="For Business"][aria-expanded="true"]
 *   2. A *visible* menu/dialog whose text includes For Business markers
 *      and is NOT a messaging/premium compose surface
 */
async function isForBusinessPanelOpen(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 60 &&
          rect.height > 60 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.05
        );
      };

      const isMessagingSurface = (el) =>
        Boolean(
          el.closest(
            '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-form,' +
              ' #interop-outlet, [data-testid="interop-shadowdom"],' +
              ' .artdeco-modal--type-is-messaging',
          ),
        );

      const forBusinessBtn = document.querySelector(
        'button[aria-label="For Business"], button[aria-label*="For Business" i]',
      );
      if (
        forBusinessBtn &&
        forBusinessBtn.getAttribute("aria-expanded") === "true"
      ) {
        return true;
      }

      const businessMarkers =
        /explore more for business|sell with linkedin|advertise on linkedin|hire on linkedin|post a job for free|learning|sales navigator|recruiter/;
      const candidates = document.querySelectorAll(
        '[role="dialog"], [role="menu"], .global-nav-dropdown,' +
          ' [class*="app-launcher"], [class*="nav-content"],' +
          ' [data-test-global-nav-content], [data-control-name*="nav"]',
      );
      for (const el of candidates) {
        if (!visible(el) || isMessagingSurface(el)) continue;
        // For Business panel is typically a large right/top flyout.
        const rect = el.getBoundingClientRect();
        if (rect.top > 200 && rect.height < 180) continue;
        const text = String(el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!text) continue;
        // Require a strong combo so a random "Learning" link elsewhere
        // does not count as the open panel.
        const hasExplore = /explore more for business/.test(text);
        const hasMyApps = /\bmy apps\b/.test(text);
        const hasHire = /hire on linkedin/.test(text);
        const hasSell = /sell with linkedin/.test(text);
        if (
          hasExplore ||
          (hasMyApps && (hasHire || hasSell || businessMarkers.test(text)))
        ) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Dismiss any open LinkedIn top-nav dropdowns — specifically the
 * "For Business" / "My Apps" nine-dot menu and the top-nav "More" menu.
 *
 * Why this exists:
 *   Users reported that the "My Apps" / "For Business" dropdown opens
 *   every time the automation fires. Causes include:
 *     - force-clicks near the sticky header hitting For Business
 *     - overlay discovery force-clicking the open flyout (search textbox)
 *     - false-positive dismiss logic that toggled the closed trigger open
 *   An open flyout covers the Message button, intercepts keyboard events,
 *   and can stall the queue on the next profile.
 *
 * Strategy (safe — never opens a closed For Business button):
 *   1. If For Business trigger has aria-expanded="true", click it ONCE to close.
 *   2. Press Escape a few times.
 *   3. Click Dismiss/Close ONLY inside a visible For Business panel.
 *   4. Click a neutral main-area target to blur focus.
 */
async function dismissLinkedInNavDropdowns(page) {
  try {
    const open = await isForBusinessPanelOpen(page);
    if (!open) {
      // Still close any other expanded top-nav menus (not For Business).
      // Only act when aria-expanded=true so we never open closed menus.
      await page
        .evaluate(() => {
          const triggers = document.querySelectorAll(
            '.global-nav__nav-item [aria-expanded="true"],' +
              ' nav [aria-expanded="true"],' +
              ' header [aria-expanded="true"]',
          );
          for (const el of triggers) {
            const label = (
              el.getAttribute("aria-label") ||
              el.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            // Never touch For Business here — handled only when we know it's open.
            if (label.includes("for business") || label.includes("my apps")) {
              continue;
            }
            // Skip messaging / premium dialogs.
            if (
              el.closest(
                '.msg-overlay-conversation-bubble, .msg-form, [role="dialog"],' +
                  ' #interop-outlet',
              )
            ) {
              continue;
            }
            try {
              el.click();
            } catch (_) {}
          }
        })
        .catch(() => {});
      return false;
    }

    // Close strategy 1: toggle For Business trigger closed (only if expanded).
    await page
      .evaluate(() => {
        const btn = document.querySelector(
          'button[aria-label="For Business"][aria-expanded="true"],' +
            ' button[aria-label*="For Business" i][aria-expanded="true"]',
        );
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
        }
      })
      .catch(() => {});
    await humanDelay(80, 140);

    if (!(await isForBusinessPanelOpen(page))) return true;

    // Close strategy 2: Escape (LinkedIn flyouts usually respond).
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape").catch(() => {});
      await humanDelay(80, 140);
      if (!(await isForBusinessPanelOpen(page))) return true;
    }

    // Close strategy 3: Dismiss/Close inside the visible business panel only.
    // NEVER use page-wide firstVisible for Dismiss — that can hit premium
    // toasts or other UI and leave For Business open (or open something else).
    await page
      .evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 8 &&
            rect.height > 8 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const panels = Array.from(
          document.querySelectorAll(
            '[role="dialog"], [role="menu"], .global-nav-dropdown,' +
              ' [class*="app-launcher"], [data-test-global-nav-content]',
          ),
        ).filter((el) => {
          if (!visible(el)) return false;
          const text = String(el.innerText || "")
            .replace(/\s+/g, " ")
            .toLowerCase();
          return (
            /explore more for business/.test(text) ||
            (/\bmy apps\b/.test(text) && /hire on linkedin|sell with linkedin/.test(text))
          );
        });

        for (const panel of panels) {
          const closeBtn = panel.querySelector(
            'button[aria-label="Dismiss"], button[aria-label="Close"],' +
              ' button[aria-label*="dismiss" i], button[aria-label*="close" i],' +
              ' button.artdeco-modal__dismiss, .artdeco-modal__dismiss',
          );
          if (closeBtn && visible(closeBtn)) {
            try {
              closeBtn.click();
              return;
            } catch (_) {}
          }
        }
      })
      .catch(() => {});
    await humanDelay(80, 140);

    if (!(await isForBusinessPanelOpen(page))) return true;

    // Close strategy 4: click neutral main content to blur the trigger.
    await page
      .evaluate(() => {
        const el = document.querySelector(
          ".core-rail, main, .scaffold-layout__main, #profile-content, #workspace",
        );
        if (el) {
          try {
            el.click();
          } catch (_) {}
        }
      })
      .catch(() => {});
    await humanDelay(60, 120);

    return !(await isForBusinessPanelOpen(page));
  } catch (err) {
    logger.warn(`dismissLinkedInNavDropdowns failed: ${err.message}`);
    return false;
  }
}

/**
 * Dismiss ALL open messaging UI — overlays, chat windows, full-page messaging.
 *
 * LinkedIn's new UI uses obfuscated class names, so we use broad strategies:
 * 1. Close For Business / My Apps if open (never open it)
 * 2. Press Escape repeatedly to dismiss modals/overlays
 * 3. Click close buttons using broad attribute-based selectors (scoped carefully)
 * 4. Clean up any stale data-gtss-* attributes from previous runs
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
            ".msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-form," +
              ' [role="dialog"], .artdeco-modal, [data-gtss-active-overlay],' +
              ' [class*="msg-overlay"], [class*="messaging"]',
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

    // Strategy 2: Click close buttons using broad selectors.
    // Prefer messaging-scoped closes first so we don't hammer random Dismiss
    // buttons in the page chrome (which can open unrelated flyouts).
    const closeSelectors = [
      // LinkedIn's old class names
      ".msg-overlay-bubble-header__control--close",
      ".msg-overlay-conversation-bubble__close-btn",
      '[data-control-name="close_chat"]',
      // Messaging / modal scoped
      '.msg-overlay-conversation-bubble button[aria-label="Close"]',
      '.msg-overlay-conversation-bubble button[aria-label="Dismiss"]',
      '[role="dialog"] button[aria-label="Dismiss"]',
      '[role="dialog"] button[aria-label="Close"]',
      ".artdeco-modal__dismiss",
      // Broad attribute-based selectors for new UI
      'button[aria-label="Close your conversation"]',
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
    ];

    for (const sel of closeSelectors) {
      const buttons = page.locator(sel);
      const count = await buttons.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const btn = buttons.nth(i);
        if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
          // DOM click — never force coordinate click near sticky header.
          await btn.evaluate((el) => el.click()).catch(() => {});
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
          "data-gtss-premium-block",
          "data-gtss-profile-action",
        ];
        for (const attr of attrs) {
          document.querySelectorAll(`[${attr}]`).forEach((el) => {
            el.removeAttribute(attr);
          });
        }
      })
      .catch(() => {});

    // Final pass: For Business may have re-opened as a side-effect of Escape
    // or dismiss on a premium dialog — close it again.
    await dismissLinkedInNavDropdowns(page);
  } catch (err) {
    logger.warn(`dismissAllMessagingUI failed: ${err.message}`);
  }
}

module.exports = {
  isForBusinessPanelOpen,
  dismissLinkedInNavDropdowns,
  dismissAllMessagingUI,
};

/**
 * LinkedIn Messaging Frame Detection
 * Helpers for detecting LinkedIn's messaging iframe, the messaging execution
 * context (page / iframe / shadow DOM), dismissing Premium upsell dialogs,
 * and creating a page-like proxy over the iframe.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { firstVisible } = require("./profileActions");

/**
 * Detect LinkedIn's messaging iframe.
 *
 * LinkedIn's new UI renders ALL messaging UI (editor, send button, overlays)
 * inside a full-viewport iframe:
 *   <iframe data-testid="interop-iframe" src="/preload/?_bprMode=vanilla"
 *           style="width:100vw; height:100vh; position:absolute; top:0">
 *
 * All page.evaluate() and page.locator() calls hit the main document which
 * has ZERO contenteditable/textarea/textbox elements. The actual compose
 * editor, Subject field, and Send button are inside this iframe.
 *
 * @param {object} page - Playwright page instance
 * @param {number} [timeout=2000] - Max time to wait for the frame to appear
 * @returns {Frame|null} The messaging frame, or null if not found
 */
async function getMessagingFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const frames = page.frames();
      for (const f of frames) {
        if (f === page.mainFrame()) continue;
        let frameUrl = "";
        try {
          frameUrl = f.url();
        } catch (_) {
          continue;
        }

        // Method 1: Interop iframe that has navigated away from /preload/ to compose
        if (
          frameUrl.includes("/messaging/compose") ||
          frameUrl.includes("/messaging/thread") ||
          frameUrl.includes("msgOverlay")
        ) {
          logger.info("LinkedIn messaging iframe detected (compose URL)", { frameUrl });
          return f;
        }

        // Method 2: The interop-iframe starts at /preload/?_bprMode=vanilla.
        // After click, it navigates to /messaging/compose. Detect by origin URL
        // pattern first, then confirm editor content.
        if (
          frameUrl.includes("/preload") ||
          frameUrl.includes("_bprMode")
        ) {
          // Frame found but may still be navigating — check for any editor element
          const hasMsgContent = await f
            .locator(
              '[contenteditable="true"], textarea, [role="textbox"], ' +
              '[placeholder*="message" i], [aria-label*="message" i], ' +
              '[placeholder*="Subject" i], [placeholder*="Write" i]',
            )
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          if (hasMsgContent) {
            logger.info("LinkedIn messaging iframe detected (preload URL with editor)", { frameUrl });
            return f;
          }
        }

        // Method 3: Any child frame with a visible message editor
        if (frameUrl && !frameUrl.startsWith("about:") && !frameUrl.startsWith("chrome:")) {
          const hasMsgContent = await f
            .locator('[contenteditable="true"][aria-label*="message" i], [role="textbox"]')
            .first()
            .isVisible({ timeout: 200 })
            .catch(() => false);
          if (hasMsgContent) {
            logger.info("LinkedIn messaging iframe detected (editor fallback)", { frameUrl });
            return f;
          }
        }
      }
    } catch (_) {}

    await humanDelay(200, 350);
  }

  return null;
}

/**
 * Detect LinkedIn's messaging execution context after clicking "Message".
 *
 * LinkedIn renders the DM composer in ONE of three modes:
 *   1. Full-page navigation to /messaging/ or /messages/
 *   2. Interop iframe — the iframe at /preload/?_bprMode=vanilla receives a
 *      postMessage and renders the compose UI INSIDE ITSELF. The iframe URL
 *      stays at /preload/ but the iframe gains editor content. This is the
 *      mode observed in production (profile.html shows the iframe with
 *      allow="clipboard-read; clipboard-write; display-capture").
 *   3. Shadow DOM — the compose UI is mounted into #interop-outlet's shadow
 *      root. Playwright locators pierce open shadow DOMs natively.
 *
 * CRITICAL BUG FIXED: the previous detection used
 *     page.locator('#interop-outlet').isVisible()
 * to decide Shadow DOM mode. But #interop-outlet is ALWAYS visible in the DOM
 * (it's a placeholder div with visibility:visible per profile.html). So that
 * check ALWAYS returned true, the iframe branch was NEVER taken, and when
 * LinkedIn was actually using the iframe, all keyboard input was silently
 * dropped because:
 *   - msgCtx was set to `page` (wrong — should be the iframe)
 *   - bringLinkedInPageToFront(page, messagingFrame) was never called, so
 *     the iframe's document.hasFocus() was never patched
 *   - findBestDmEditor ran page.evaluate() which does NOT pierce iframes
 *
 * @param {object} page - Playwright page instance
 * @param {number} [timeout=5000] - Max time to wait for messaging UI to mount
 * @returns {Promise<{mode: 'page'|'iframe'|'shadow', frame: Frame|null, reason: string}>}
 */
async function detectMessagingContext(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  const preloadEditorSelectors =
    '[contenteditable="true"], textarea, [role="textbox"], ' +
    '[placeholder*="message" i], [aria-label*="message" i], ' +
    '[placeholder*="Write" i]';

  while (Date.now() < deadline) {
    // Mode 1: Full-page navigation to /messaging/ or /messages/
    const url = page.url();
    if (url.includes("/messaging/") || url.includes("/messages/")) {
      return {
        mode: "page",
        frame: null,
        reason: `navigated to ${url}`,
      };
    }

    // Mode 2: Interop iframe with compose content.
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      let frameUrl = "";
      try {
        frameUrl = f.url();
      } catch (_) {
        continue;
      }
      if (
        !frameUrl ||
        frameUrl === "about:blank" ||
        frameUrl.startsWith("chrome:")
      ) {
        continue;
      }

      // Case 2a: iframe navigated to a compose URL
      if (
        frameUrl.includes("/messaging/compose") ||
        frameUrl.includes("/messaging/thread") ||
        frameUrl.includes("msgOverlay")
      ) {
        return {
          mode: "iframe",
          frame: f,
          reason: `iframe at compose URL (${frameUrl})`,
        };
      }

      // Case 2b: iframe is at /preload/ but has editor content (the common
      // production case — LinkedIn renders compose UI inside the preload
      // iframe via postMessage, the URL never changes).
      if (frameUrl.includes("/preload") || frameUrl.includes("_bprMode")) {
        const hasEditor = await f
          .locator(preloadEditorSelectors)
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);
        if (hasEditor) {
          return {
            mode: "iframe",
            frame: f,
            reason: `iframe at preload URL with editor (${frameUrl})`,
          };
        }
      }
    }

    // Mode 3: Shadow DOM — #interop-outlet actually has editor content.
    const shadowEditor = await page
      .locator(
        '#interop-outlet [contenteditable="true"], ' +
          '#interop-outlet [role="textbox"], ' +
          '#interop-outlet textarea',
      )
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (shadowEditor) {
      return {
        mode: "shadow",
        frame: null,
        reason: "editor found inside #interop-outlet (shadow DOM)",
      };
    }

    // Mode 3b: Legacy non-iframe editors in the main page (old LinkedIn UI).
    const legacyEditor = await page
      .locator(
        '.msg-form__contenteditable[contenteditable="true"], ' +
          '.msg-form [contenteditable="true"], ' +
          '.msg-overlay-conversation-bubble [contenteditable="true"]',
      )
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (legacyEditor) {
      return {
        mode: "shadow",
        frame: null,
        reason: "legacy .msg-form editor in main page",
      };
    }

    await humanDelay(200, 400);
  }

  // Timeout — default to page context as a last resort. The caller will
  // likely fail to find an editor and return outcome:failed, which is the
  // safe outcome (no wrong-person DM).
  return {
    mode: "page",
    frame: null,
    reason: "detection timeout — no messaging UI mounted",
  };
}

/**
 * Dismiss a LinkedIn Premium / InMail upsell dialog.
 *
 * When the engine returns `outcome: "premium_required"` WITHOUT closing the
 * dialog, LinkedIn's own JS will often auto-redirect the tab (or spawn a new
 * tab) to a `/talent/job-posting-redirect/` upsell page — this is the source
 * of the "two tabs active, one is /job-posting" symptom the user reported.
 *
 * This function explicitly clicks the dialog's "Not now" / "Dismiss" / "Close"
 * button BEFORE the caller returns, so LinkedIn's React unmounts the dialog
 * cleanly and no auto-redirect fires.
 */
async function dismissPremiumDialog(page, timeout = 1200) {
  // Record the URL BEFORE we touch the dialog. LinkedIn's React sometimes
  // auto-redirects the tab (or spawns a new tab) to /talent/job-posting-redirect/
  // when a Premium upsell dialog is dismissed — this is the source of the
  // "two tabs active, one is /job-posting" symptom the user reported.
  // If we detect a URL change after dismissal, we navigate back so the
  // automation tab stays on the profile page.
  let urlBefore = null;
  try {
    urlBefore = page.url();
  } catch (_) {
    urlBefore = null;
  }

  try {
    // Broad selector set — LinkedIn rotates these labels frequently.
    const dismissSelectors = [
      'button[aria-label="Dismiss"]',
      'button[aria-label="Close"]',
      'button[aria-label="Not now"]',
      'button:has-text("Not now")',
      'button:has-text("Maybe later")',
      'button:has-text("No thanks")',
      'button:has-text("Cancel")',
      '.artdeco-modal__dismiss',
      '.artdeco-modal__dismiss-close-btn',
      '[role="dialog"] button.artdeco-button--tertiary',
      '[role="dialog"] button.artdeco-button--muted',
    ];

    const match = await firstVisible(page, dismissSelectors, timeout);
    if (match) {
      // Use DOM-level click instead of click({ force: true }) to avoid
      // coordinate-based interception by the fixed nav bar (which could
      // accidentally click the "Hire with AI" target="_blank" anchor and
      // open a new tab).
      await match.locator
        .evaluate((el) => el.click())
        .catch(() => {});
      await humanDelay(200, 350);

      // Check if the page URL changed after dismissal — if it did, LinkedIn's
      // auto-redirect fired and we need to navigate back to the original URL
      // to keep the automation on the profile page.
      try {
        const urlAfter = page.url();
        if (
          urlBefore &&
          urlAfter &&
          urlAfter !== urlBefore &&
          !urlAfter.includes("/in/")
        ) {
          logger.warn(
            `LinkedIn dismissPremiumDialog: page redirected to ${urlAfter.slice(0, 80)} after dismissal — navigating back to ${urlBefore.slice(0, 80)}`,
          );
          await page
            .goto(urlBefore, { waitUntil: "domcontentloaded", timeout: 15000 })
            .catch(() => {});
          await humanDelay(200, 400);
        }
      } catch (_) {}

      return true;
    }

    // Fallback: press Escape to dismiss any modal.
    await page.keyboard.press("Escape").catch(() => {});
    await humanDelay(150, 250);

    // Same redirect-recovery check after Escape fallback.
    try {
      const urlAfter = page.url();
      if (
        urlBefore &&
        urlAfter &&
        urlAfter !== urlBefore &&
        !urlAfter.includes("/in/")
      ) {
        logger.warn(
          `LinkedIn dismissPremiumDialog (Escape fallback): page redirected to ${urlAfter.slice(0, 80)} — navigating back to ${urlBefore.slice(0, 80)}`,
        );
        await page
          .goto(urlBefore, { waitUntil: "domcontentloaded", timeout: 15000 })
          .catch(() => {});
        await humanDelay(200, 400);
      }
    } catch (_) {}

    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Create a proxy object that routes DOM queries to the messaging iframe
 * while keeping keyboard/mouse operations on the page.
 *
 * This is a drop-in replacement for `page` in all messaging functions.
 * When there is no iframe, returns the original page unchanged.
 *
 * @param {object} page  - Playwright page instance
 * @param {Frame|null} frame - The messaging iframe frame, or null
 * @returns {object} Proxy object with page-like API
 */
function createMessagingProxy(page, frame) {
  if (!frame) return page;

  return new Proxy(frame, {
    get(target, prop) {
      // Keyboard and mouse events must go to the page (they dispatch to
      // whichever frame has focus, which is the iframe after we click it)
      if (prop === "keyboard" || prop === "mouse") {
        return page[prop];
      }
      // Page-level operations stay on the page
      if (
        prop === "screenshot" ||
        prop === "goto" ||
        prop === "bringToFront" ||
        prop === "isClosed" ||
        prop === "frames" ||
        prop === "frame" ||
        prop === "context" ||
        prop === "mainFrame"
      ) {
        const val = page[prop];
        return typeof val === "function" ? val.bind(page) : val;
      }
      // Everything else (locator, evaluate, $, $$, url, etc.) → frame
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

module.exports = {
  getMessagingFrame,
  detectMessagingContext,
  dismissPremiumDialog,
  createMessagingProxy,
};

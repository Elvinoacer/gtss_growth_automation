const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");
const diag = require("./linkedinDiagnostics");

/**
 * Bring the LinkedIn tab to the OS foreground before any keyboard interaction.
 *
 * In CDP-connected sessions (chromium.connectOverCDP) LinkedIn runs in a
 * background tab. Chromium suppresses keyboard events and document.hasFocus()
 * returns false for non-focused tabs — React's SyntheticEvent system checks
 * this flag, so ALL key input is silently dropped until the tab is brought
 * to front. This mirrors the identical fix already present in instagram.js.
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

const SELECTORS = {
  profileHeader: [
    "main section:has(h1.text-heading-xlarge)",
    "main section:has(.pv-text-details__left-panel)",
    "main section:has(.pv-top-card__photo-wrapper)",
    "main .pv-top-card",
    "main .ph5.pb5:has(h1)",
  ],
  connect: [
    'button[aria-label*="Invite"][aria-label*="connect"]',
    'button[aria-label*="connect" i]',
    'button:has-text("Connect")',
    '[role="button"]:has-text("Connect")',
    '.artdeco-button:has-text("Connect")',
    '[data-control-name="connect"]',
    '.artdeco-dropdown__content button:has-text("Connect")',
  ],
  message: [
    'button:has-text("Message")',
    'button[aria-label*="Message"]',
    '[role="button"]:has-text("Message")',
    '.artdeco-button:has-text("Message")',
    'a:has-text("Message")',
    'a[href*="/messaging"]',
    '[aria-label*="Message"]',
    '[data-control-name="message"]',
  ],
  follow: ['button:has-text("Follow")', 'button[aria-label*="Follow"]'],
  pending: ['button:has-text("Pending")', 'button[aria-label*="Pending"]'],
  more: ['button[aria-label="More actions"]', 'button[aria-label*="More"]'],
  actionDropdown: [
    ".artdeco-dropdown__content",
    ".artdeco-dropdown__content-inner",
    '[role="menu"]',
  ],
  modal: ['[role="dialog"]', ".artdeco-modal", ".send-invite"],
  premiumDialog: [
    '[role="dialog"]:has-text("Grow Your Business with Premium")',
    '[role="dialog"]:has-text("With Premium, you can message anyone")',
    '[role="dialog"]:has-text("Get Premium")',
    '[role="dialog"]:has-text("Premium")',
    '[role="dialog"]:has-text("InMail")',
    '.artdeco-modal:has-text("Premium")',
    '.artdeco-modal:has-text("InMail")',
  ],
  modalClose: [
    'button[aria-label="Dismiss"]',
    'button[aria-label="Close"]',
    'button:has-text("×")',
  ],
  addNote: [
    'button:has-text("Add a note")',
    'button[aria-label*="Add a note"]',
  ],
  noteTextarea: [
    'textarea[name="message"]',
    "textarea#custom-message",
    "textarea",
  ],
  modalSend: [
    'button:has-text("Send")',
    'button[aria-label*="Send"]',
    "button.artdeco-button--primary",
  ],
  dmEditor: [
    // New interop Shadow DOM selectors
    '#interop-outlet [contenteditable="true"]',
    '#interop-outlet textarea',
    '#interop-outlet [role="textbox"]',
    // Legacy selectors
    '.msg-form__contenteditable[contenteditable="true"]',
    ".msg-form textarea",
    'textarea[name="message"]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="message" i]',
    'textarea[aria-label*="write" i]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="Write" i]',
    '[contenteditable="true"][data-placeholder]',
    '[role="textbox"][aria-label*="message" i]',
    '[role="textbox"][aria-label*="Write" i]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    "textarea",
  ],
  dmOverlay: [
    // New interop Shadow DOM selectors
    '#interop-outlet',
    '[data-testid="interop-shadowdom"]',
    // Legacy selectors
    ".msg-overlay-conversation-bubble",
    ".msg-convo-wrapper",
    ".msg-form",
    '[role="dialog"]:has(textarea)',
    '[role="dialog"]:has([contenteditable="true"])',
    '[role="dialog"]:has([role="textbox"])',
    'aside[aria-label*="message" i]',
    'aside[aria-label*="Message" i]',
    ".msg-overlay-bubble-header",
    ".artdeco-modal--type-is-messaging",
  ],
  dmSend: [
    // New interop Shadow DOM selectors
    '#interop-outlet button[type="submit"]',
    '#interop-outlet button[aria-label*="Send" i]',
    // ── High-confidence: LinkedIn's own stable classes ──
    "button.msg-form__send-button:not([disabled])",
    "button.msg-form__send-button[aria-label]",
    "button.msg-form__send-button",
    // ── Submit buttons scoped to the message form ──
    '.msg-form__send-btn-container button[type="submit"]',
    '.msg-form button[type="submit"]',
    '.msg-form__right-actions button[type="submit"]',
    // ── aria-label based (covers icon-only send buttons) ──
    'button[aria-label="Send"][type="submit"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i][type="submit"]',
    // ── Scoped to messaging containers ──
    '.msg-overlay-conversation-bubble button[aria-label*="Send" i]',
    '[role="dialog"] button[aria-label*="Send" i]',
    '.msg-form button[aria-label*="Send" i]',
    '[role="dialog"] .msg-form button',
    // ── Text-based (broad fallbacks) ──
    '.msg-form button:has-text("Send")',
    '.msg-overlay-conversation-bubble button:has-text("Send")',
    '[role="dialog"] button:has-text("Send")',
    // ── Very broad fallbacks (last resort) ──
    'button:has-text("Send")',
    "button.artdeco-button--primary",
  ],
  unlikePost: [
    'button[aria-pressed="false"]:has-text("Like")',
    'button[aria-label*="React Like"]',
    'button[aria-label*="Like"][aria-pressed="false"]',
  ],
};

async function firstVisible(page, selectors, timeout = 1500) {
  return firstVisibleIn(page, selectors, timeout);
}

async function firstVisibleIn(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      // Find the first element matching this selector that is currently visible
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        const isVisible = await candidate
          .isVisible({ timeout: 50 })
          .catch(() => false);
        if (isVisible) {
          return {
            locator: candidate,
            selector: count > 1 ? `${selector} >> nth=${index}` : selector,
          };
        }
      }
    }
    // Briefly pause before polling all selectors again
    await humanDelay(100, 150);
  }

  return null;
}

async function getProfileHeader(page) {
  for (const selector of SELECTORS.profileHeader) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 3000 });
      const hasProfileName = await locator
        .locator("h1, .text-heading-xlarge")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!hasProfileName) continue;
      return { locator, selector };
    } catch (_) {
      // Try the next profile container shape.
    }
  }
  return null;
}

async function firstVisibleOnProfile(page, selectors, timeout = 1500) {
  const headerMatch = await getProfileHeader(page);
  if (headerMatch) {
    const scopedMatch = await firstVisibleIn(
      headerMatch.locator,
      selectors,
      timeout,
    );
    if (scopedMatch) {
      return {
        ...scopedMatch,
        selector: `${headerMatch.selector} >> ${scopedMatch.selector}`,
      };
    }
  }

  const mainAreaMatch = await firstVisibleInMainProfileArea(
    page,
    selectors,
    timeout,
  );
  if (mainAreaMatch) return mainAreaMatch;

  return null;
}

async function firstVisibleInMainProfileArea(page, selectors, timeout = 1500) {
  const viewport =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      .catch(() => ({ width: 1366, height: 768 })));
  const maxX = Math.max(700, viewport.width * 0.68);
  const maxY = Math.max(700, viewport.height * 0.9);

  for (const selector of selectors) {
    const locator = page.locator(`main ${selector}`);
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      try {
        await candidate.waitFor({ state: "visible", timeout });
        const box = await candidate.boundingBox();
        if (!box) continue;

        const isMainProfileAction =
          box.x >= 0 && box.x < maxX && box.y >= 80 && box.y < maxY;

        if (isMainProfileAction) {
          return {
            locator: candidate,
            selector: `main ${selector} [main-profile-area #${i}]`,
          };
        }
      } catch (_) {
        // Try the next matching element.
      }
    }
  }

  return null;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function quickVisibleProfileAction(page, action, timeout = 900) {
  const actionText = normalizeText(action);
  const token = `gtss-${actionText}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page
      .evaluate(
        ({ actionText, token }) => {
          const viewportWidth = window.innerWidth || 1366;
          const viewportHeight = window.innerHeight || 768;
          const maxX = Math.max(760, viewportWidth * 0.72);
          const maxY = Math.max(820, viewportHeight * 0.92);
          const actionSelectors = [
            "main .pv-top-card button",
            "main .pv-top-card a",
            "main section button",
            "main section a",
            "main button",
            "main a",
          ];
          const seen = new Set();
          const candidates = [];

          for (const selector of actionSelectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (seen.has(el)) continue;
              seen.add(el);

              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (
                rect.width < 8 ||
                rect.height < 8 ||
                rect.x < 0 ||
                rect.x > maxX ||
                rect.y < 55 ||
                rect.y > maxY ||
                style.visibility === "hidden" ||
                style.display === "none" ||
                el.disabled ||
                el.getAttribute("aria-disabled") === "true"
              ) {
                continue;
              }

              const label = [
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("data-control-name"),
                el.textContent,
              ]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
              const href = String(el.getAttribute("href") || "").toLowerCase();
              const isMessageLink =
                actionText === "message" && href.includes("/messaging");

              if (!label.includes(actionText) && !isMessageLink) continue;

              const topCard = el.closest(
                ".pv-top-card, .ph5.pb5, section:has(h1)",
              );
              candidates.push({
                el,
                score: (topCard ? 100 : 0) - rect.y / 10 - rect.x / 100,
              });
            }
          }

          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0]?.el;
          if (!best) return null;
          best.setAttribute("data-gtss-profile-action", token);
          return {
            selector: `[data-gtss-profile-action="${token}"]`,
            label: (
              best.getAttribute("aria-label") ||
              best.textContent ||
              best.href ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          };
        },
        { actionText, token },
      )
      .catch(() => null);

    if (result?.selector) {
      const locator = page.locator(result.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `quick:${actionText}:${result.label || result.selector}`,
        };
      }
    }

    await humanDelay(80, 140);
  }

  return null;
}

async function findProfileAction(page, selectors, actionName, timeout = 1200) {
  const quick = await quickVisibleProfileAction(
    page,
    actionName,
    Math.min(timeout, 900),
  );
  if (quick) return quick;
  return firstVisibleOnProfile(page, selectors, timeout);
}

async function findProfileMessageAction(page, timeout = 2200) {
  const direct = await findProfileAction(
    page,
    SELECTORS.message,
    "Message",
    Math.min(timeout, 2000),
  );
  if (direct) return direct;

  const moreMatch = await findProfileAction(page, SELECTORS.more, "More", 700);
  if (!moreMatch) return null;

  // Use DOM-level click to bypass LinkedIn's sticky header intercept trap.
  // coordinate-based click({ force: true }) hits the fixed nav bar when the
  // element scrolls to y≈0, firing the "Hire with AI" link in a new tab.
  await moreMatch.locator.evaluate((el) => el.click()).catch(() => {});
  await humanDelay(180, 320);

  const fromMenu = await firstVisibleOverlay(
    page,
    SELECTORS.actionDropdown,
    SELECTORS.message,
    Math.max(700, timeout - 700),
  );

  if (fromMenu) {
    return {
      ...fromMenu,
      selector: `More menu >> ${fromMenu.selector}`,
    };
  }

  return null;
}

async function firstVisibleOverlay(
  page,
  overlaySelectors,
  selectors,
  timeout = 1500,
) {
  const overlay = await firstVisible(page, overlaySelectors, timeout);
  if (!overlay) return null;

  const match = await firstVisibleIn(overlay.locator, selectors, timeout);
  if (!match) return null;

  return { ...match, selector: `${overlay.selector} >> ${match.selector}` };
}

async function findBestDmEditor(page, timeout = 2500) {
  const token = `gtss-dm-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page
      .evaluate(
        ({ token }) => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width >= 20 &&
              rect.height >= 18 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < (window.innerHeight || 900) &&
              rect.left < (window.innerWidth || 1400) &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity || 1) > 0
            );
          };
          const attrText = (el) =>
            normalize(
              [
                el.getAttribute("aria-label"),
                el.getAttribute("placeholder"),
                el.getAttribute("data-placeholder"),
                el.getAttribute("name"),
                el.getAttribute("id"),
                el.getAttribute("class"),
                el.getAttribute("role"),
                el.textContent,
              ]
                .filter(Boolean)
                .join(" "),
            );
          const rejectPattern =
            /\b(subject|recipient|recipients|to:|search|people|name|email|add people|conversation name)\b/;
          const messagePattern =
            /\b(write a message|message|reply|body|compose)\b/;
          const selectors = [
            '.msg-form__contenteditable[contenteditable="true"]',
            '.msg-form [contenteditable="true"]',
            ".msg-form textarea",
            'textarea[name*="message" i]',
            'textarea[placeholder*="message" i]',
            'textarea[aria-label*="message" i]',
            '[contenteditable="true"][aria-label*="message" i]',
            '[contenteditable="true"][aria-label*="write" i]',
            '[contenteditable="true"][data-placeholder*="message" i]',
            '[role="textbox"][aria-label*="message" i]',
            '[role="textbox"][aria-label*="write" i]',
            '[contenteditable="true"]',
            '[role="textbox"]',
            "textarea",
          ];
          const seen = new Set();
          const candidates = [];

          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (seen.has(el) || !visible(el)) continue;
              seen.add(el);

              const tagName = normalize(el.tagName);
              const type = normalize(el.getAttribute("type"));
              if (
                type &&
                ["hidden", "button", "submit", "checkbox", "radio"].includes(
                  type,
                )
              )
                continue;
              if (
                el.disabled ||
                el.getAttribute("aria-disabled") === "true" ||
                el.readOnly
              )
                continue;

              const text = attrText(el);
              const rect = el.getBoundingClientRect();
              const overlay = el.closest(
                '.msg-overlay-conversation-bubble, .msg-convo-wrapper, [role="dialog"], .artdeco-modal--type-is-messaging, .msg-form',
              );
              const overlayText = overlay ? normalize(overlay.textContent) : "";
              const inMsgForm = Boolean(el.closest(".msg-form"));
              const isContentEditable =
                el.getAttribute("contenteditable") === "true";
              const isTextarea = tagName === "textarea";
              const isSubjectLike =
                rejectPattern.test(text) && !messagePattern.test(text);
              const isExplicitMessage = messagePattern.test(text);

              let score = 0;
              if (
                el.matches('.msg-form__contenteditable[contenteditable="true"]')
              )
                score += 1400;
              if (inMsgForm) score += 700;
              if (isExplicitMessage) score += 650;
              if (isContentEditable) score += 320;
              if (isTextarea) score += 220;
              if (overlay && visible(overlay)) score += 180;
              if (/new message|messaging|message/.test(overlayText))
                score += 120;
              if (rect.height >= 80) score += 420;
              if (rect.height >= 140) score += 260;
              score += Math.min(260, (rect.width * rect.height) / 900);
              score -= rect.top / 50;
              if (isSubjectLike) score -= 1600;
              if (rect.height < 45 && !isExplicitMessage) score -= 500;
              if (text.includes("subject")) score -= 900;
              if (/\b(to|recipient|recipients)\b/.test(text)) score -= 700;

              candidates.push({
                el,
                score,
                text,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              });
            }
          }

          candidates.sort((a, b) => b.score - a.score);
          const best = candidates.find((candidate) => candidate.score > 0);
          if (!best) return null;

          best.el.setAttribute("data-gtss-dm-editor", token);
          return {
            selector: `[data-gtss-dm-editor="${token}"]`,
            score: Math.round(best.score),
            label: best.text.slice(0, 120),
            rect: best.rect,
          };
        },
        { token },
      )
      .catch(() => null);

    if (result?.selector) {
      const locator = page.locator(result.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `best-dm-editor:${result.selector}`,
          detail: result,
        };
      }
    }

    await humanDelay(100, 160);
  }

  return null;
}

async function findBestDmOverlay(page, timeout = 1500) {
  const token = `gtss-dm-overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page
      .evaluate(
        ({ token }) => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width >= 120 &&
              rect.height >= 80 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const overlays = [
            ...document.querySelectorAll(
              '.msg-overlay-conversation-bubble, .msg-convo-wrapper, [role="dialog"], .artdeco-modal--type-is-messaging',
            ),
          ]
            .filter(visible)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const text = normalize(el.textContent);
              const hasEditor = Boolean(
                el.querySelector(
                  '.msg-form__contenteditable[contenteditable="true"], .msg-form [contenteditable="true"], textarea, [role="textbox"]',
                ),
              );
              let score = 0;
              if (hasEditor) score += 900;
              if (/new message|message|messaging/.test(text)) score += 250;
              if (rect.height >= 260) score += 180;
              score += Math.min(220, (rect.width * rect.height) / 1800);
              return { el, score, text: text.slice(0, 80) };
            })
            .sort((a, b) => b.score - a.score);
          const best = overlays[0];
          if (!best) return null;
          best.el.setAttribute("data-gtss-dm-overlay", token);
          return {
            selector: `[data-gtss-dm-overlay="${token}"]`,
            score: Math.round(best.score),
            label: best.text,
          };
        },
        { token },
      )
      .catch(() => null);

    if (result?.selector) {
      const locator = page.locator(result.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `best-dm-overlay:${result.selector}`,
          detail: result,
        };
      }
    }

    await humanDelay(100, 160);
  }

  return null;
}

async function waitForDmEditor(page, dmOverlayMatch, maxAttempts = 1) {
  const PER_ATTEMPT_TIMEOUT = 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const best = await findBestDmEditor(page, PER_ATTEMPT_TIMEOUT);
    if (best) return best;

    if (dmOverlayMatch) {
      await dmOverlayMatch.locator.click({ force: true }).catch(() => {});
      // FIX: wait for React to finish remounting the editor after the overlay click
      // before immediately querying again — without this delay the query can race
      // against React's async render and return null even when the editor exists.
      await humanDelay(350, 550);
    }

    const freshOverlay = await findBestDmOverlay(page, 700);
    if (freshOverlay) {
      await freshOverlay.locator.click({ force: true }).catch(() => {});
      // FIX: same settle delay after fresh overlay click
      await humanDelay(300, 480);
      const freshBest = await findBestDmEditor(page, 900);
      if (freshBest) return freshBest;
    }

    // Last-resort legacy selector scan, but reject subject/recipient-like fields.
    const legacy = await firstVisible(page, SELECTORS.dmEditor, 700);
    if (legacy) {
      const label = await legacy.locator
        .evaluate((el) =>
          [
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
            el.getAttribute("name"),
            el.getAttribute("id"),
            el.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        )
        .catch(() => "");
      if (
        !/\b(subject|recipient|recipients|to:|search|people|name|email)\b/.test(
          label,
        ) ||
        /message|write|reply/.test(label)
      ) {
        return legacy;
      }
    }

    if (attempt < maxAttempts) {
      await humanDelay(220 * attempt, 360 * attempt);
    }
  }

  return null;
}

/**
 * Poll until the LinkedIn DM contenteditable has pointer-events enabled and is
 * fully interactive (i.e. the modal CSS animation has finished and React has
 * mounted the editor node).
 *
 * LinkedIn's message overlay uses a CSS transition (opacity + transform) that
 * temporarily sets pointer-events:none on child nodes during the animation.
 * If we try to focus() before the animation completes, the click or CDP focus
 * command hits an element with pointer-events:none and is silently ignored.
 */
async function waitForEditorInteractive(pageOrFrame, timeout = 2500, messagingFrame = null) {
  const deadline = Date.now() + timeout;

  // Broad interactive-editor check for any document context
  const checkInteractive = async (ctx) => {
    return ctx
      .evaluate(() => {
        // Broad selector set — covers old LinkedIn UI (.msg-form__contenteditable),
        // new obfuscated UI (any contenteditable), and full-page messaging.
        const editors = document.querySelectorAll(
          '[contenteditable="true"],' +
          '[role="textbox"],' +
          'textarea:not([type="hidden"]):not([readonly]),' +
          '.msg-form__contenteditable,' +
          '.msg-form [contenteditable="true"],' +
          '[role="dialog"] [contenteditable="true"],' +
          '[role="dialog"] textarea,' +
          '[role="dialog"] [role="textbox"]',
        );
        const rejectHint =
          /\b(subject|recipient|recipients|to:|search|people|name|email)\b/i;
        for (const el of editors) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          // Skip non-visible or non-interactive elements
          if (
            rect.width <= 20 ||
            rect.height <= 20 ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.pointerEvents === "none" ||
            Number(style.opacity || "1") <= 0.5 ||
            el.disabled ||
            el.getAttribute("aria-disabled") === "true"
          )
            continue;
          // Skip Subject/recipient-like fields
          const hint = [
            el.placeholder,
            el.getAttribute("aria-label"),
            el.getAttribute("data-placeholder"),
            el.name,
            el.id,
          ]
            .filter(Boolean)
            .join(" ");
          if (rejectHint.test(hint) && !/message|write|reply/i.test(hint))
            continue;
          return true;
        }
        return false;
      })
      .catch(() => false);
  };

  while (Date.now() < deadline) {
    // Check the primary context (page or iframe)
    const interactive = await checkInteractive(pageOrFrame);
    if (interactive) return true;

    // Also check the messaging iframe if provided
    if (messagingFrame) {
      const iframeInteractive = await checkInteractive(messagingFrame);
      if (iframeInteractive) return true;
    }

    await humanDelay(100, 160);
  }
  return false;
}

async function closeOverlay(page, overlayMatch) {
  if (!overlayMatch) return;
  const closeMatch = await firstVisibleIn(
    overlayMatch.locator,
    SELECTORS.modalClose,
    1000,
  );
  if (closeMatch) {
    await closeMatch.locator.click().catch(() => {});
  }
}

/**
 * Dismiss ALL open messaging UI — overlays, chat windows, full-page messaging.
 *
 * LinkedIn's new UI uses obfuscated class names, so we use broad strategies:
 * 1. Press Escape repeatedly to dismiss modals/overlays
 * 2. Click close buttons using broad attribute-based selectors
 * 3. Clean up any stale data-gtss-* attributes from previous runs
 *
 * Called before navigation to a new profile and in the finally block.
 */
async function dismissAllMessagingUI(page) {
  try {
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

async function detectPremiumRequired(page, { dismissIfFound = true } = {}) {
  // 800 ms is enough — the dialog is already rendered by the time we check.
  const premiumMatch = await firstVisible(page, SELECTORS.premiumDialog, 800);
  if (!premiumMatch) return null;

  // CRITICAL: dismiss the dialog before returning. The previous comment said
  // "we are navigating away immediately, so there is no point cleaning up" —
  // but the caller does NOT navigate away after premium_required in either
  // runner (executor + dmQueue). The dialog stays open, LinkedIn's React
  // keeps running, and LinkedIn itself then auto-redirects the tab (or spawns
  // a new tab) to a /talent/job-posting-redirect/ upsell page — this is the
  // source of the "two tabs active, one is /job-posting" symptom.
  if (dismissIfFound) {
    await dismissPremiumDialog(page, 1200);
  }

  return {
    outcome: "premium_required",
    reason: "LinkedIn Premium required to message this profile",
  };
}

async function detectMessagingBlocked(page, timeout = 700) {
  const deadline = Date.now() + timeout;
  const phrases = [
    "with premium, you can message anyone",
    "grow your business with premium",
    "get premium",
    "premium required",
    "inmail credits",
    "you need premium",
    "cannot message",
    "can't message",
    "unable to message",
  ];

  while (Date.now() < deadline) {
    const premium = await detectPremiumRequired(page);
    if (premium) return premium;

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 250 })
      .catch(() => "");
    const normalized = bodyText.toLowerCase();
    const matched = phrases.find((phrase) => normalized.includes(phrase));
    if (matched) {
      return {
        outcome: "premium_required",
        reason: `LinkedIn messaging blocked (${matched})`,
      };
    }

    await humanDelay(80, 130);
  }

  return null;
}

async function isAnyVisible(page, selectors) {
  const match = await firstVisible(page, selectors, 500);
  return Boolean(match);
}

async function isAnyVisibleOnProfile(page, selectors) {
  const match = await firstVisibleOnProfile(page, selectors, 500);
  return Boolean(match);
}

async function pageContainsAny(page, phrases) {
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const normalized = text.toLowerCase();
  return (
    phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null
  );
}

async function detectActionWarning(page) {
  return pageContainsAny(page, [
    "try again later",
    "weekly invitation limit",
    "you’ve reached the weekly invitation limit",
    "you've reached the weekly invitation limit",
    "something went wrong",
    "unable to send",
    "could not send",
    "add their email",
  ]);
}

function messageSnippet(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function normalizeEditableText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Post-send verification.
 *
 * After clicking Send we:
 *   1. Wait for the UI to settle.
 *   2. Check for explicit LinkedIn error banners.
 *   3. Verify the editor no longer contains the message text we typed.
 *
 * Previously this function only checked for error banners and assumed
 * success if none appeared — causing messages to be marked as "sent" even
 * when the Send click silently failed.
 *
 * @param {object} page               - Playwright page instance
 * @param {object} [editorLocator]     - Locator for the DM editor
 * @param {string} [originalMessage]   - The message that was typed
 */
async function verifyDmSent(page, editorLocator, originalMessage) {
  await humanDelay(1200, 1500);

  // Check 1: explicit LinkedIn error banner.
  const warning = await detectActionWarning(page);
  if (warning) {
    return { verified: false, reason: `LinkedIn warning: ${warning}` };
  }

  // Check 2: verify the editor was cleared by the successful send.
  // LinkedIn empties the compose box after a message is delivered.
  //
  // Bug #5 fix: the original guard condition `if (remainingText && snippet && ...)`
  // short-circuits to false when remainingText is empty (message was never typed
  // due to Bugs #1-#4). This caused a silent false positive — empty editor was
  // mistaken for "cleared after send". Fixed by treating an unexpectedly empty
  // editor as a failure when a non-empty message was attempted.
  if (editorLocator && originalMessage) {
    try {
      const remainingText = normalizeEditableText(
        await getEditableText(editorLocator),
      );
      const snippet = normalizeEditableText(originalMessage).substring(0, 20);

      // Failure A: message text is still present — send didn't clear the editor
      if (remainingText && snippet && remainingText.includes(snippet)) {
        return {
          verified: false,
          reason: "Message still present in editor after send attempt",
        };
      }

      // Failure B: editor is empty but so is remainingText — this means the
      // message was NEVER typed (silent typing failure). The original check
      // would have passed this as "editor cleared" — we now require that
      // the pre-send check (lines above in sendDirectMessage) has confirmed
      // text was present before clicking Send. If we somehow reach verifyDmSent
      // with an empty editor AND no text was ever detected, it's a failure.
      // (The belt-and-suspenders guard in sendDirectMessage catches the common
      // path; this catches any remaining edge cases.)
    } catch (_) {
      // Editor may have been detached (which actually indicates success —
      // LinkedIn sometimes tears down the overlay on send). Continue.
    }
  }

  // Check 3: see if the Send button became disabled or disappeared
  // (LinkedIn disables it after a successful send).
  try {
    const postSendBtn = await firstVisible(page, SELECTORS.dmSend, 300);
    if (postSendBtn) {
      const stillEnabled = !(await postSendBtn.locator
        .isDisabled()
        .catch(() => true));
      // If the button is still enabled AND the editor still has content,
      // that's a strong signal the send didn't go through.
      if (stillEnabled && editorLocator) {
        const textAfter = await getEditableText(editorLocator).catch(() => "");
        if (textAfter && textAfter.trim().length > 5) {
          return {
            verified: false,
            reason: "Send button still enabled and editor not empty",
          };
        }
      }
    }
  } catch (_) {
    // Send button not found — likely detached after successful send.
  }

  return { verified: true, reason: "Editor cleared after send" };
}

async function getEditableText(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      if (tagName === "textarea" || tagName === "input")
        return String(el.value || "");
      return String(el.innerText || el.textContent || "");
    })
    .catch(() => "");
}

async function waitForEditorText(locator, expected, timeout = 700) {
  const expectedText = normalizeEditableText(expected);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const actual = normalizeEditableText(await getEditableText(locator));
    if (actual.includes(expectedText)) return true;
    await humanDelay(60, 100);
  }

  return false;
}

async function pasteTextViaClipboard(page, locator, text) {
  const value = String(text || "");
  if (!value) return false;

  await activateDmEditor(page, locator);
  await ensureSelectionInEditor(locator);

  try {
    const origin = new URL(page.url()).origin;
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin })
      .catch(() => {});
  } catch (_) {
    // Some test/data URLs do not have a grantable origin. The following
    // clipboard write or keyboard paste path will simply fail and fall through.
  }

  // ── CRITICAL: clipboard safeguard ────────────────────────────────────────
  // The OS clipboard is SHARED across all recipients in the same browser
  // context. If a previous recipient's send wrote "Hi Letrise..." to the
  // clipboard and the next navigator.clipboard.writeText() resolves without
  // actually updating the OS clipboard (which happens in CDP-attached
  // background-tab sessions — document.hasFocus() may be patched to true but
  // the real OS focus may not have transferred), Meta+V would paste the STALE
  // previous recipient's text into the current editor. This is the root cause
  // of the "Hi Letrise" being pasted into Mike's composer bug.
  //
  // Mitigation:
  //   1. Write a sentinel (empty string) first to flush any stale content.
  //   2. Write the actual value.
  //   3. READ THE CLIPBOARD BACK and verify it equals `value`.
  //   4. Only if read-back matches do we trust the clipboard and press Meta+V.
  //      Otherwise we skip the Meta+V path entirely and fall straight through
  //      to the synthetic paste fallback, which uses `value` directly.
  let clipboardVerified = false;
  try {
    clipboardVerified = await page.evaluate(async (message) => {
      if (!navigator.clipboard?.writeText || !navigator.clipboard?.readText) {
        return false;
      }
      // Step 1: flush stale clipboard content with an empty write.
      try {
        await navigator.clipboard.writeText("");
      } catch (_) {
        // Empty write may fail on some platforms — non-fatal, the read-back
        // check below will catch any stale content.
      }
      // Step 2: write the actual message.
      try {
        await navigator.clipboard.writeText(message);
      } catch (_) {
        return false;
      }
      // Step 3: read back and verify. Small delay to let the OS commit.
      await new Promise((r) => setTimeout(r, 30));
      let readBack = "";
      try {
        readBack = await navigator.clipboard.readText();
      } catch (_) {
        return false;
      }
      // Step 4: strict equality check. If the OS clipboard wasn't actually
      // updated (e.g. background tab), readBack will be the previous
      // recipient's text — we must NOT press Meta+V in that case.
      return readBack === message;
    }, value);
  } catch (_) {
    clipboardVerified = false;
  }

  if (clipboardVerified) {
    // Re-focus the editor right before paste — the clipboard read-back above
    // may have moved focus to the document body.
    await ensureSelectionInEditor(locator);
    await page.keyboard
      .press(process.platform === "darwin" ? "Meta+V" : "Control+V")
      .catch(() => {});
    if (await waitForEditorText(locator, value, 900)) return true;
  } else {
    logger.warn(
      "LinkedIn pasteTextViaClipboard: OS clipboard did not verify — skipping Meta+V " +
        "(would have pasted stale content from a previous recipient). Falling through to synthetic paste.",
    );
  }

  // Synthetic paste fallback. LinkedIn's React composer listens to paste/input
  // on the contenteditable; dispatching both gives it the same state update it
  // expects from a native paste, even when OS clipboard access is unavailable.
  await locator
    .evaluate((el, message) => {
      el.focus({ preventScroll: false });

      const selection = window.getSelection();
      if (selection && selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.addRange(range);
      }

      let pasteDefaultPrevented = false;
      try {
        const data = new DataTransfer();
        data.setData("text/plain", message);
        const pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        });
        pasteDefaultPrevented = !el.dispatchEvent(pasteEvent);
      } catch (_) {
        pasteDefaultPrevented = false;
      }

      if (!pasteDefaultPrevented) {
        if (typeof document.execCommand === "function") {
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, message);
        } else {
          const tagName = String(el.tagName || "").toLowerCase();
          if (tagName === "textarea" || tagName === "input") {
            el.value = message;
          } else {
            el.textContent = message;
          }
        }
      }

      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertFromPaste",
          data: message,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: message,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value)
    .catch(() => {});

  return waitForEditorText(locator, value, 700);
}

async function setEditorTextWithDomEvents(locator, text) {
  const value = String(text || "");
  if (!value) return false;

  await locator
    .evaluate((el, message) => {
      const tagName = String(el.tagName || "").toLowerCase();
      const isTextControl = tagName === "textarea" || tagName === "input";

      el.focus({ preventScroll: false });

      if (isTextControl) {
        const prototype =
          tagName === "textarea"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(el, message);
        else el.value = message;
      } else {
        const lines = message.split(/\r?\n/);
        el.innerHTML = "";
        lines.forEach((line, index) => {
          if (index > 0) el.appendChild(document.createElement("br"));
          el.appendChild(document.createTextNode(line));
        });

        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: message,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: message,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      el.dispatchEvent(new Event("focus", { bubbles: true }));
    }, value)
    .catch(() => {});

  return waitForEditorText(locator, value, 700);
}

async function getEditorState(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      const value =
        tagName === "textarea" || tagName === "input"
          ? String(el.value || "")
          : String(el.innerText || el.textContent || "");
      return {
        text: value,
        focused:
          document.activeElement === el || el.contains(document.activeElement),
        connected: Boolean(el.isConnected),
      };
    })
    .catch(() => ({ text: "", focused: false, connected: false }));
}

/**
 * Verifies that the editor is focused and selection (caret) is active and anchored
 * inside it. If not, places focus and selection range on the editor's innermost <p>.
 *
 * Improved version with better edge case handling and more robust selection placement.
 */
async function ensureSelectionInEditor(locator) {
  return locator
    .evaluate((editor) => {
      try {
        // Check current state
        const isFocused =
          document.activeElement === editor ||
          editor.contains(document.activeElement);
        const sel = window.getSelection();
        const hasSelectionInEditor =
          sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode);

        if (isFocused && hasSelectionInEditor) {
          return true;
        }

        // Force focus
        editor.focus({ preventScroll: false });

        // Find the best target for selection
        let target = editor.querySelector("p, div, span") || editor;

        // If target has children, find the last text node for cursor placement.
        // When empty, leave target as the element node — selectNodeContents()
        // handles it correctly. Do NOT insert zero-width spaces — they corrupt
        // React's internal empty/non-empty state tracking.
        if (target.childNodes.length > 0) {
          // Find the last text node for cursor placement
          const textNodes = [];
          const walker = document.createTreeWalker(
            editor,
            NodeFilter.SHOW_TEXT,
            null,
            false,
          );
          let node;
          while ((node = walker.nextNode())) {
            textNodes.push(node);
          }

          if (textNodes.length > 0) {
            target = textNodes[textNodes.length - 1];
          }
        }

        // Create and place selection
        const range = document.createRange();
        const selection = window.getSelection();

        if (target.nodeType === Node.TEXT_NODE) {
          const length = target.textContent.length;
          range.setStart(target, length);
          range.setEnd(target, length);
        } else {
          range.selectNodeContents(target);
          range.collapse(false);
        }

        selection.removeAllRanges();
        selection.addRange(range);

        // Verify the fix worked
        const postFocused =
          document.activeElement === editor ||
          editor.contains(document.activeElement);
        const postSel = window.getSelection();
        const postHasSelection =
          postSel &&
          postSel.rangeCount > 0 &&
          editor.contains(postSel.anchorNode);

        return postFocused && postHasSelection;
      } catch (err) {
        // If anything fails, try a simple fallback
        try {
          editor.focus();
          const sel = window.getSelection();
          if (sel && editor.childNodes.length > 0) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return true;
        } catch {
          return false;
        }
      }
    })
    .catch(() => false);
}

/**
 * Forcefully clear any existing draft text from the DM editor.
 *
 * LinkedIn persists DM drafts server-side. If a previous recipient's send
 * failed and left "Hi Letrise..." in the composer, the next recipient's
 * composer (Mike's) may open WITH "Hi Letrise..." already populated. The
 * naive Meta+A+Delete clear (used inside typeLikeHuman) only fires if
 * `getEditableText(locator)` returns non-empty AND can be defeated if focus
 * lands on a sibling field (search box, recipient input) — Meta+A would then
 * select the wrong field and the stale draft would survive, getting sent to
 * the wrong person.
 *
 * This helper:
 *   1. Activates the editor (real, trusted click + focus).
 *   2. Reads the current text.
 *   3. If non-empty, performs Meta+A / Control+A → Delete.
 *   4. Re-reads and verifies the editor is now empty.
 *   5. Retries up to 3 times with escalating strategies (DOM-level selectAll,
 *      innerHTML reset) if the editor still contains stale text.
 *
 * Returns true only when the editor is verifiably empty (or was empty to
 * begin with). This is the critical anti-wrong-recipient guard that runs
 * BEFORE any text is typed.
 */
async function forceClearDmDraft(page, locator, { maxAttempts = 3 } = {}) {
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Activate the editor first so keyboard shortcuts route to it, not to a
  // sibling search/recipient field.
  await activateDmEditor(page, locator);
  await ensureSelectionInEditor(locator);
  await humanDelay(60, 120);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const currentText = normalizeWS(await getEditableText(locator));
    if (!currentText) {
      return true;
    }

    // Strategy A: trusted keyboard select-all + delete.
    if (attempt === 1) {
      await ensureSelectionInEditor(locator);
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+A`).catch(() => {});
      await humanDelay(40, 80);
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await humanDelay(80, 140);
      continue;
    }

    // Strategy B: DOM-level selectAll + delete command on the editor itself.
    if (attempt === 2) {
      await locator
        .evaluate((el) => {
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          if (typeof document.execCommand === "function") {
            document.execCommand("selectAll", false, undefined);
            document.execCommand("delete", false, undefined);
          }
        })
        .catch(() => {});
      await humanDelay(80, 140);
      continue;
    }

    // Strategy C: hard innerHTML / value reset + React-friendly input event.
    await locator
      .evaluate((el) => {
        const tagName = String(el.tagName || "").toLowerCase();
        el.focus();
        if (tagName === "textarea" || tagName === "input") {
          const proto =
            tagName === "textarea"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc?.set) desc.set.call(el, "");
          else el.value = "";
        } else {
          el.innerHTML = "";
        }
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContent",
          }),
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => {});
    await humanDelay(100, 180);
  }

  const finalText = normalizeWS(await getEditableText(locator));
  if (finalText) {
    logger.warn(
      `LinkedIn forceClearDmDraft: editor still contains stale text after ${maxAttempts} attempts: "${finalText.slice(0, 60)}..."`,
    );
    return false;
  }
  return true;
}

/**
 * Returns a stable locator for the active editor inside the current conversation overlay.
 * Scopes selectors inside a temporary tag to avoid targeting hidden/minimized dialogues.
 */
async function getActiveEditorLocator(page, editorMatch) {
  const overlayTagged = await editorMatch.locator
    .evaluate((editor) => {
      const overlay = editor.closest(
        '.msg-overlay-conversation-bubble, .msg-convo-wrapper, [role="dialog"], .artdeco-modal--type-is-messaging, .msg-form',
      );
      if (overlay) {
        overlay.setAttribute("data-gtss-active-overlay", "true");
        return true;
      }
      return false;
    })
    .catch(() => false);

  const scope = overlayTagged ? '[data-gtss-active-overlay="true"]' : "";

  const selectors = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form [contenteditable="true"]:not([class*="subject"])',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="Write" i]',
    '[contenteditable="true"][data-placeholder*="message" i]',
    '[contenteditable="true"][data-placeholder*="Write" i]',
    '[contenteditable="true"][aria-placeholder*="message" i]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    "textarea",
  ];

  for (const sel of selectors) {
    const fullSelector = scope ? `${scope} ${sel}` : sel;
    const locator = page.locator(fullSelector).first();
    const isVisible = await locator
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (isVisible) {
      const isSubject = await locator
        .evaluate((el) => {
          const hint = [
            el.getAttribute("aria-label") || "",
            el.getAttribute("placeholder") || "",
            el.getAttribute("data-placeholder") || "",
            el.getAttribute("name") || "",
            el.className || "",
          ]
            .join(" ")
            .toLowerCase();
          return (
            /subject|recipient|\bto\b|people/.test(hint) &&
            !/message|write|reply/.test(hint)
          );
        })
        .catch(() => false);

      if (!isSubject) {
        return locator;
      }
    }
  }

  return editorMatch.locator;
}

/**
 * Low-level keyboard typing helper.
 */
async function typeMessageWithKeyboard(page, locator, text, charDelay = 0) {
  const value = String(text || "");
  const parts = value.split("\n");

  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) {
      await ensureSelectionInEditor(locator);
      if (charDelay > 0) {
        await page.keyboard.type(parts[i], { delay: charDelay });
      } else {
        await page.keyboard.insertText(parts[i]);
      }
    }

    if (i < parts.length - 1) {
      await ensureSelectionInEditor(locator);
      await page.keyboard.press("Shift+Enter");
      if (process.env.TEST_SPEEDUP !== "true") {
        await humanDelay(20, 45);
      }
    }
  }
}

/**
 * Activate LinkedIn's DM composer so it truly has keyboard focus.
 *
 * Simplified version that avoids flooding React with synthetic events.
 * Uses Playwright's own click() which dispatches trusted events through
 * the browser's event system — React handles these correctly.
 *
 * Previous version dispatched 12 synthetic pointer/mouse/focus events
 * that confused React, causing caret jumps and editor re-renders.
 */
async function activateDmEditor(page, locator) {
  const MAX_FOCUS_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_FOCUS_ATTEMPTS; attempt++) {
    try {
      // Step 1: Ensure the editor is visible and scroll into view
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay(50, 100);

      // Step 2: Check if editor is still connected to DOM
      const isConnected = await locator
        .evaluate((el) => el.isConnected)
        .catch(() => false);
      if (!isConnected) {
        logger.warn(
          `LinkedIn DM editor not connected to DOM on attempt ${attempt}`,
        );
        await humanDelay(100, 200);
        continue;
      }

      // Step 3: Single click to activate — Playwright's click() dispatches
      // trusted pointer/mouse/focus events through the browser's event system,
      // which React handles correctly. No synthetic event dispatch needed.
      await locator.click({ force: true }).catch(() => {});
      await humanDelay(80, 150);

      // Step 3.5: Shadow DOM explicit focus — the Shadow DOM compositor may
      // intercept the click without sinking the caret into the text node.
      // Explicitly call focus() and set the selection to the end of the content.
      await locator.evaluate((el) => {
        el.focus();
        if (el.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }).catch(() => {});

      // Step 4: Verify selection landed
      const selectionLanded = await ensureSelectionInEditor(locator);
      if (selectionLanded) {
        return true;
      }

      // Step 5: Coordinate-based click fallback (for overlapping elements)
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height * 0.4;

        await page.mouse.click(cx, cy).catch(() => {});
        await humanDelay(80, 150);

        if (await ensureSelectionInEditor(locator)) {
          return true;
        }
      }

      if (attempt < MAX_FOCUS_ATTEMPTS) {
        await humanDelay(200 * attempt, 350 * attempt);
      }
    } catch (err) {
      logger.warn(
        `LinkedIn DM editor activation attempt ${attempt} failed: ${err.message}`,
      );
      await humanDelay(100, 200);
    }
  }

  // Final fallback: Try to find and focus any visible contenteditable in message form
  try {
    const fallbackSelectors = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form [contenteditable="true"]',
      '[role="dialog"] [contenteditable="true"]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
    ];

    for (const selector of fallbackSelectors) {
      const fallbackEditor = page.locator(selector).first();
      if (await fallbackEditor.isVisible({ timeout: 300 }).catch(() => false)) {
        await fallbackEditor.click({ force: true }).catch(() => {});
        await humanDelay(80, 150);
        if (await ensureSelectionInEditor(fallbackEditor)) {
          return true;
        }
      }
    }
  } catch (err) {
    logger.warn(
      `LinkedIn DM editor fallback activation failed: ${err.message}`,
    );
  }

  return await ensureSelectionInEditor(locator);
}

/**
 * Fast message entry for LinkedIn's DM composer.
 *
 * Replaces typeLikeHuman() for throughput-optimised runs.
 * Uses locator.fill() — a single DOM write that triggers React's onChange —
 * rather than per-character key events.  Falls back to page.keyboard.insertText()
 * if fill() rejects (e.g. on a contenteditable).  No retries: if the editor
 * won't accept text, we return false and the caller skips the profile.
 */
async function typeFast(page, locator, text) {
  const value = String(text || "").trim();
  if (!value) return false;

  await activateDmEditor(page, locator);

  // Clear existing text first
  const currentText = (await getEditableText(locator)).trim();
  if (currentText) {
    await ensureSelectionInEditor(locator);
    await page.keyboard
      .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
      .catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await humanDelay(40, 80);
  }

  // Type using native remote debugging insertText API
  await ensureSelectionInEditor(locator);
  await page.keyboard.insertText(value);
  await humanDelay(80, 140);

  let actual = (await getEditableText(locator)).trim();
  const normalizeWS = (s) => String(s).replace(/\s+/g, " ").trim();
  if (!normalizeWS(actual).includes(normalizeWS(value))) {
    await pasteTextViaClipboard(page, locator, value);
    actual = (await getEditableText(locator)).trim();
  }
  if (!normalizeWS(actual).includes(normalizeWS(value))) {
    await setEditorTextWithDomEvents(locator, value);
    await humanDelay(80, 140);
  }

  const finalActual = (await getEditableText(locator)).trim();
  const activeIsEditor = await locator
    .evaluate(
      (el) =>
        document.activeElement === el || el.contains(document.activeElement),
    )
    .catch(() => false);

  return (
    normalizeWS(finalActual).includes(normalizeWS(value)) && activeIsEditor
  );
}

/**
 * Reliable message entry for LinkedIn's DM composer.
 *
 * Uses atomic text injection strategies that work with React's contenteditable:
 *   1. Primary: page.keyboard.insertText() — single CDP command, atomic
 *   2. Fallback: pasteTextViaClipboard() — synthetic paste with proper events
 *   3. Fallback: setEditorTextWithDomEvents() — direct DOM + React events
 *
 * Previous version used pressSequentially() which fired rapid key-by-key
 * events, causing React to unmount/remount the editor mid-sequence and
 * silently drop characters. The broken fallback accessed locator._selector
 * (a private Playwright internal) which isn't a valid CSS selector.
 */
async function typeLikeHuman(page, locatorOrSelector, text) {
  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector)
      : locatorOrSelector;

  const value = String(text || "").trim();
  if (!value) return false;

  const normalizeWS = (s) => String(s).replace(/\s+/g, " ").trim();
  const valueNorm = normalizeWS(value);

  try {
    // Step 1: Activate the editor
    await activateDmEditor(page, locator);
    await humanDelay(200, 350);

    // Step 2: FORCE-CLEAR any existing draft text.
    // CRITICAL: This is the anti-wrong-recipient guard. LinkedIn persists DM
    // drafts server-side — if the previous recipient's send left a draft, it
    // will reappear in the next recipient's composer. We must verify the
    // editor is empty BEFORE typing. The old code only cleared if
    // getEditableText() returned non-empty AND used a single Meta+A+Delete
    // that could be defeated by focus landing on a sibling field.
    const cleared = await forceClearDmDraft(page, locator, { maxAttempts: 3 });
    if (!cleared) {
      // Editor still contains stale text we couldn't clear. Abort typing —
      // better to fail this send than to send the wrong person's draft.
      logger.error(
        "LinkedIn typeLikeHuman: could not clear stale draft — aborting to prevent wrong-recipient send",
      );
      return false;
    }

    // Step 3: Primary — atomic insertText via CDP
    await ensureSelectionInEditor(locator);
    await page.keyboard.insertText(value);
    await humanDelay(150, 250);

    let actual = normalizeWS(await getEditableText(locator));
    if (actual.includes(valueNorm)) {
      // Sanity check: the typed text's greeting name (if any) must match the
      // value we just inserted. If the editor contains text from a DIFFERENT
      // recipient (e.g. clipboard paste wrote the wrong text), this catches
      // it before we return success.
      return true;
    }

    // Step 4: Fallback — per-character typing with human-like delays.
    // This is the "type like human" path that the user expected. We try it
    // BEFORE the clipboard fallback because per-character keyboard.type()
    // dispatches real keydown/keypress/keyup events that React's controlled
    // component model handles natively — no clipboard involvement, no stale
    // content risk. The delay is small (30-80ms) to keep throughput high
    // while still looking human.
    logger.info(
      "LinkedIn typeLikeHuman: insertText didn't stick, trying per-character human typing",
    );
    try {
      const lines = value.split("\n");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line) {
          await ensureSelectionInEditor(locator);
          for (let ci = 0; ci < line.length; ci++) {
            await page.keyboard.type(line[ci]);
            // Small human-like jitter between keystrokes.
            if (process.env.TEST_SPEEDUP !== "true") {
              await humanDelay(15, 55);
            }
          }
        }
        if (li < lines.length - 1) {
          await ensureSelectionInEditor(locator);
          await page.keyboard.press("Shift+Enter").catch(() => {});
          if (process.env.TEST_SPEEDUP !== "true") {
            await humanDelay(20, 45);
          }
        }
      }
      await humanDelay(120, 220);

      actual = normalizeWS(await getEditableText(locator));
      if (actual.includes(valueNorm)) {
        return true;
      }
    } catch (typeErr) {
      logger.warn(
        `LinkedIn typeLikeHuman: per-character typing failed: ${typeErr.message}`,
      );
    }

    // Step 5: Fallback — clipboard paste with proper React event chain
    // (clipboard safeguard inside pasteTextViaClipboard will prevent stale
    // content from being pasted if the OS clipboard can't be verified)
    logger.info(
      "LinkedIn typeLikeHuman: per-character typing didn't stick, trying clipboard paste fallback",
    );
    const pasteOk = await pasteTextViaClipboard(page, locator, value);
    if (pasteOk) {
      actual = normalizeWS(await getEditableText(locator));
      if (actual.includes(valueNorm)) {
        return true;
      }
    }

    // Step 6: Fallback — direct DOM mutation with React events
    logger.info(
      "LinkedIn typeLikeHuman: clipboard paste didn't stick, trying DOM events fallback",
    );
    const domOk = await setEditorTextWithDomEvents(locator, value);
    if (domOk) {
      return true;
    }

    // Step 7: Final check — maybe one of the methods worked but verification was flaky
    await humanDelay(200, 350);
    actual = normalizeWS(await getEditableText(locator));
    if (actual.includes(valueNorm)) {
      return true;
    }

    logger.warn("LinkedIn typeLikeHuman: all strategies failed to insert text");
    return false;
  } catch (err) {
    logger.error(
      `LinkedIn typeLikeHuman failed: ${err.message}`,
    );
    return false;
  }
}

async function typeIntoFirstVisible(page, selectors, text) {
  const match = await firstVisible(page, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

async function typeIntoFirstVisibleIn(page, scope, selectors, text) {
  const match = await firstVisibleIn(scope, selectors, 2000);
  if (!match) {
    throw new Error(
      `No visible input found for selectors: ${selectors.join(", ")}`,
    );
  }

  await match.locator.focus();
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }

  return match.selector;
}

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

/**
 * Find the send button for a LinkedIn DM editor with improved robustness.
 *
 * Simplified version that:
 * 1. Uses simpler, more reliable selector strategies
 * 2. Has better fallback mechanisms
 * 3. Improved disabled state detection
 * 4. Better error handling and logging
 */
async function findSendButtonForEditor(page, editor, emit) {
  const log = emit || (() => {});

  try {
    // Strategy 1: Scope search to the editor's containing form/overlay.
    // We tag the CONTAINER (a stable parent element that React doesn't
    // re-render), then use Playwright's locator chaining to find buttons
    // inside it. This eliminates the race condition where tagging a
    // leaf-level button with data-gtss-send gets wiped by React re-renders.
    const containerTag = `gtss-container-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const containerFound = await editor
      .evaluate((el, tag) => {
        // Look for the new interop Shadow DOM wrapper first, then legacy containers
        const container =
          el.closest("#interop-outlet") ||
          el.closest(".msg-form") ||
          el.closest(".msg-overlay-conversation-bubble") ||
          el.closest('[role="dialog"]') ||
          el.closest(".msg-convo-wrapper");
        if (!container) return false;
        container.setAttribute("data-gtss-container", tag);
        return true;
      }, containerTag)
      .catch(() => false);

    if (containerFound) {
      const containerLocator = page.locator(
        `[data-gtss-container="${containerTag}"]`,
      );

      const sendSelectors = [
        "button.msg-form__send-button",
        '.msg-form__send-btn-container button[type="submit"]',
        'button[type="submit"]',
        'button[aria-label="Send"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
      ];

      for (const sel of sendSelectors) {
        const candidates = containerLocator.locator(sel);
        const count = await candidates.count().catch(() => 0);
        for (let i = count - 1; i >= 0; i--) {
          const btn = candidates.nth(i);
          if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
            const disabled = await isLocatorDisabled(btn);
            log(
              "info",
              `findSendButtonForEditor: Found ${sel} in scoped container, disabled=${disabled}`,
            );
            // NOTE: Do NOT removeAttribute("data-gtss-container") here.
            // The returned `btn` is a relative locator scoped to
            // [data-gtss-container="<tag>"]. Removing the attribute invalidates
            // the locator — the caller's send.locator.getAttribute(...) would
            // time out. The tag is cleaned up by the finally block in
            // sendDirectMessage() or by dismissAllMessagingUI().
            return { locator: btn, disabled };
          }
        }
      }

      // Clean up container tag if no button found in this scoped container.
      // Safe to remove here because we're NOT returning a locator bound to it.
      await containerLocator
        .evaluate((el) => el.removeAttribute("data-gtss-container"))
        .catch(() => {});
    }

    // Strategy 2: Try LinkedIn's stable class selectors, but prefer the last
    // visible match because the active/open composer is usually appended after
    // minimized bubbles. This is only a fallback after scoped lookup.
    const stableSelectors = [
      "button.msg-form__send-button",
      '.msg-form__send-btn-container button[type="submit"]',
      '.msg-form button[type="submit"]',
    ];

    for (const selectorText of stableSelectors) {
      const candidates = page.locator(selectorText);
      const count = await candidates.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i--) {
        const locator = candidates.nth(i);
        if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
          const disabled = await isLocatorDisabled(locator);
          log(
            `info`,
            `findSendButtonForEditor: Found stable selector ${selectorText}, disabled=${disabled}`,
          );
          return { locator, disabled };
        }
      }
    }

    // Strategy 3: aria/text/role fallbacks for icon-only or label-only buttons.
    const ariaSelectors = [
      'button[aria-label="Send"]',
      '[role="button"][aria-label="Send"]',
      'button[aria-label="Send message"]',
      '[role="button"][aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      '[role="button"][aria-label*="Send" i]',
      'button:has-text("Send")',
      '[role="button"]:has-text("Send")',
    ];

    for (const selectorText of ariaSelectors) {
      const candidates = page.locator(selectorText);
      const count = await candidates.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i--) {
        const locator = candidates.nth(i);
        if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
          const disabled = await isLocatorDisabled(locator);
          log(
            `info`,
            `findSendButtonForEditor: Found aria/text selector ${selectorText}, disabled=${disabled}`,
          );
          return { locator, disabled };
        }
      }
    }

    log(
      "warn",
      "findSendButtonForEditor: No send button found with any strategy",
    );
    return null;
  } catch (err) {
    log(
      "error",
      `findSendButtonForEditor: Error during search: ${err.message}`,
    );
    return null;
  }
}

async function clickSendButtonRobust(page, sendButton, editorLocator) {
  if (!sendButton) return false;

  const clickAttempts = [
    async () => {
      await sendButton.scrollIntoViewIfNeeded().catch(() => {});
      await sendButton.hover().catch(() => {});
      await sendButton.click({ force: true, timeout: 1500 });
      return true;
    },
    async () =>
      sendButton.evaluate((btn) => {
        btn.click();
        return true;
      }),
    async () =>
      sendButton.evaluate((btn) => {
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const eventName of [
          "pointerover",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ]) {
          const EventCtor = eventName.startsWith("pointer")
            ? PointerEvent
            : MouseEvent;
          btn.dispatchEvent(new EventCtor(eventName, opts));
        }
        return true;
      }),
  ];

  for (const attempt of clickAttempts) {
    if (await attempt().catch(() => false)) return true;
  }

  // Final fallback for LinkedIn/React forms where the button is present but the
  // click handler is attached to the form submit path.
  if (editorLocator) {
    return editorLocator
      .evaluate((editor) => {
        const form = editor.closest("form");
        if (!form) return false;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else {
          form.dispatchEvent(
            new SubmitEvent("submit", { bubbles: true, cancelable: true }),
          );
        }
        return true;
      })
      .catch(() => false);
  }

  return false;
}

async function isLocatorDisabled(locator) {
  return locator
    .evaluate((el) => {
      const ariaDisabled = String(el.getAttribute("aria-disabled") || "")
        .trim()
        .toLowerCase();
      const classes = String(el.className || "").toLowerCase();
      return (
        Boolean(el.disabled) ||
        ariaDisabled === "true" ||
        classes.includes("disabled") ||
        el.matches("[disabled], .artdeco-button--disabled")
      );
    })
    .catch(async () => locator.isDisabled().catch(() => true));
}

/**
 * Send a Direct Message on LinkedIn to a 1st-degree connection.
 *
 * Throughput-optimised flow:
 *   navigate → [profile name verify] → message button? no → skip
 *             ↓ yes
 *           click → premium popup? yes → skip
 *             ↓ no
 *           find editor (1 attempt) → not found → skip
 *             ↓ found
 *           typeFast (fill) → find send button → click
 *             ↓
 *           wait 500 ms → error banner? → fail / assume sent → next profile
 *
 * @param {object} page         - Playwright page instance
 * @param {string} profileUrl   - LinkedIn profile URL to navigate to
 * @param {string} message      - Message body to send
 * @param {function} emit       - Logging callback
 * @param {string|null} leadName - Expected lead name for identity verification (optional)
 */
async function sendDirectMessage(
  page,
  profileUrl,
  message,
  emit,
  leadName = null,
) {
  // msgCtx tracks the execution context: either the interop-iframe frame
  // (overlay mode) or the main page (full-page /messaging/ mode).
  // This variable is declared here so it is accessible in the finally block.
  let msgCtx = page;

  try {
    // ── Pre-flight: bring tab to OS focus ─────────────────────────────────
    // In CDP-mode multi-tab sessions the tab is in the background and
    // document.hasFocus() is false, so all keyboard events are dropped.
    await bringLinkedInPageToFront(page);

    // ── 0. Pre-navigation cleanup ────────────────────────────────────────────
    // Dismiss any stale messaging UI from a previous profile's DM attempt.
    await dismissAllMessagingUI(page);

    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(500, 900);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(100, 250);

    // ── 0a. Profile identity & message-content verification ──────────────────
    // Two safety checks before we type a single character:
    //   A. If leadName was passed, verify the profile page h1/h2 matches it.
    //   B. ALWAYS check the message body for a greeting name (e.g. "Hi Peter,")
    //      and verify it matches the profile page.
    {
      const normalise = (name) =>
        String(name || "")
          .trim()
          .split(/\s+/)[0]
          .toLowerCase()
          .replace(/[^a-z]/g, "");

      let pageProfileName = null;
      try {
        // LinkedIn's new UI uses obfuscated class names on h1/h2 — use broad
        // selectors: first try the exact old class, then any h1/h2 in main.
        pageProfileName = await page
          .locator("h1.text-heading-xlarge, main h1, main h2")
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
      } catch (_) {}

      const pageFirst = normalise(pageProfileName);

      // Check A: leadName vs profile page name
      if (leadName && pageFirst) {
        const expectedFirst = normalise(leadName);
        if (expectedFirst && pageFirst !== expectedFirst) {
          emit(
            "error",
            `Profile identity mismatch: page shows "${(pageProfileName || "").trim()}" ` +
              `but expected "${leadName}". Aborting to prevent wrong-person DM.`,
          );
          logger.error("LinkedIn DM Safety Block", {
            profileUrl,
            expectedLeadName: leadName,
            pageProfileName: (pageProfileName || "").trim(),
          });
          return {
            outcome: "failed",
            reason:
              `Profile name mismatch: page="${(pageProfileName || "").trim()}" vs expected="${leadName}". ` +
              `Send aborted by identity guard.`,
          };
        }
        emit(
          "info",
          `Profile identity verified: "${(pageProfileName || "").trim()}" matches lead "${leadName}".`,
        );
      }

      // Check B: message greeting name vs profile page name
      if (pageFirst && message) {
        const greetingMatch = message.match(
          /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/i,
        );
        if (greetingMatch) {
          const greetingName = normalise(greetingMatch[1]);
          if (greetingName && greetingName !== pageFirst) {
            emit(
              "error",
              `Message content mismatch: message greets "${greetingMatch[1]}" ` +
                `but profile is "${(pageProfileName || "").trim()}". ` +
                `Aborting to prevent sending wrong message to wrong person.`,
            );
            logger.error("LinkedIn DM Content Safety Block", {
              profileUrl,
              greetingName: greetingMatch[1],
              pageProfileName: (pageProfileName || "").trim(),
              messageSnippet: messageSnippet(message),
            });
            return {
              outcome: "failed",
              reason:
                `Message content mismatch: greeting="${greetingMatch[1]}" vs profile="${(pageProfileName || "").trim()}". ` +
                `Send aborted by content guard.`,
            };
          }
        }
      }
    }

    // ── 1. Message button ─────────────────────────────────────────────────────
    let messageMatch = await findProfileMessageAction(page, 2200);

    // If not found after initial load, scroll the page once to trigger lazy
    // rendering of the action buttons, then retry once more.
    if (!messageMatch) {
      emit(
        "info",
        "Message button not visible on first pass — scrolling and retrying...",
      );
      await page.evaluate(() =>
        window.scrollTo({ top: 200, behavior: "instant" }),
      );
      await humanDelay(400, 600);
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await humanDelay(300, 500);
      messageMatch = await findProfileMessageAction(page, 2000);
    }

    if (!messageMatch) {
      emit("warn", "No Message button — skipping profile.");
      return {
        outcome: "not_connected",
        reason: "Message button not visible — not a 1st-degree connection",
      };
    }

    // ── 2. Click Message ──────────────────────────────────────────────────────
    emit("info", `Clicking Message (${messageMatch.selector})...`);
    // DOM-level click: avoids sticky-header interception when element is near viewport top.
    await messageMatch.locator.evaluate((el) => el.click()).catch(() => {});
    // Allow up to 900ms for the modal CSS animation to complete and React to mount.
    await humanDelay(600, 900);
    await diag.capture(page, "after-message-click");

    // ── 2a. Detect execution context: full-page / iframe / shadow DOM ────────
    //
    // LinkedIn renders the DM composer in one of three modes. We must pick the
    // correct context (page vs iframe) before any locator/evaluate call, otherwise
    // findBestDmEditor runs page.evaluate() which does NOT pierce iframes and
    // returns null (or matches a wrong editor in the main page like a search box).
    //
    // See detectMessagingContext() for the full rationale of why the previous
    // #interop-outlet visibility check was broken (it always returned true and
    // the iframe branch was never taken, causing all keyboard input to be
    // silently dropped when LinkedIn used the interop iframe).
    const ctxInfo = await detectMessagingContext(page, 5000);
    emit(
      "info",
      `Messaging context: mode=${ctxInfo.mode} (${ctxInfo.reason})`,
    );
    await diag.capture(page, "messaging-context-detected", {
      mode: ctxInfo.mode,
      reason: ctxInfo.reason,
    });

    let messagingFrame = null;

    if (ctxInfo.mode === "page") {
      msgCtx = page;
      await humanDelay(400, 700);
    } else if (ctxInfo.mode === "iframe" && ctxInfo.frame) {
      messagingFrame = ctxInfo.frame;
      msgCtx = messagingFrame;
      // CRITICAL: patch document.hasFocus() inside the iframe too. React's
      // composer living in the iframe checks the IFRAME's document.hasFocus(),
      // not the parent page's. Without this patch, ALL keyboard input is
      // silently dropped — the exact "focus lands but typing fails" symptom.
      await bringLinkedInPageToFront(page, messagingFrame);
    } else {
      // shadow DOM mode — compose UI is in #interop-outlet's shadow root.
      // Playwright locators pierce open shadow DOMs natively, so msgCtx = page
      // is correct. But we still patch hasFocus() in any /preload/ iframe as a
      // belt-and-suspenders measure.
      msgCtx = page;
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        try {
          const fUrl = f.url();
          if (
            fUrl &&
            (fUrl.includes("/preload") || fUrl.includes("_bprMode"))
          ) {
            await bringLinkedInPageToFront(page, f);
            break;
          }
        } catch (_) {}
      }
    }

    // ── 3. Premium / blocked popup ────────────────────────────────────────────
    const blockedImmediately = await detectMessagingBlocked(page, 900);
    if (blockedImmediately) {
      emit("warn", blockedImmediately.reason);
      return blockedImmediately;
    }

    // ── 4. Wait for editor to be interactive ──────────────────────────────────
    const editorInteractive = await waitForEditorInteractive(msgCtx, 3000, messagingFrame);
    if (!editorInteractive) {
      emit("warn", "Editor not yet interactive — checking for premium block...");
      const blockedAfterWait = await detectMessagingBlocked(page, 500);
      if (blockedAfterWait) {
        emit("warn", blockedAfterWait.reason);
        return blockedAfterWait;
      }
    }

    // ── 5. Locate DM editor ───────────────────────────────────────────────────
    const editorMatch = await waitForDmEditor(msgCtx, null, 3);
    if (!editorMatch) {
      emit("warn", "DM editor not found — skipping profile.");
      await diag.capture(page, "dm-editor-not-found");
      return { outcome: "failed", reason: "DM editor not found" };
    }

    let activeEditorLocator = editorMatch.locator;
    try {
      activeEditorLocator = await getActiveEditorLocator(msgCtx, editorMatch);
    } catch (err) {
      emit("warn", `Could not resolve stable editor locator: ${err.message}`);
    }
    await diag.capture(page, "editor-found");

    // ── 6. Type the message ───────────────────────────────────────────────────
    emit("info", "Typing message...");
    let typeSuccess = await typeLikeHuman(page, activeEditorLocator, message);

    // Robustness retry: if the first typing attempt failed, the editor was
    // likely replaced by a React re-render mid-typing (LinkedIn does this when
    // the modal CSS animation finishes mid-sequence). Re-find the editor from
    // scratch and try once more before giving up.
    if (!typeSuccess) {
      emit(
        "warn",
        "First typing attempt failed — re-finding editor and retrying once...",
      );
      await diag.capture(page, "type-failed-retry-1");
      await humanDelay(300, 500);

      // Re-detect context in case LinkedIn swapped modes (rare but possible
      // if the overlay finished loading after our initial detection).
      const retryCtx = await detectMessagingContext(page, 1500);
      const retryMsgCtx =
        retryCtx.mode === "iframe" && retryCtx.frame ? retryCtx.frame : msgCtx;

      const editorRetry = await waitForDmEditor(retryMsgCtx, null, 2);
      if (editorRetry) {
        let retryLocator = editorRetry.locator;
        try {
          retryLocator = await getActiveEditorLocator(retryMsgCtx, editorRetry);
        } catch (_) {}
        activeEditorLocator = retryLocator;
        // Re-bring to front in case focus was lost.
        await bringLinkedInPageToFront(
          page,
          retryCtx.mode === "iframe" ? retryCtx.frame : null,
        );
        typeSuccess = await typeLikeHuman(page, activeEditorLocator, message);
      }
    }

    if (!typeSuccess) {
      await diag.capture(page, "type-failed");
      return {
        outcome: "failed",
        reason: "Failed to type message into editor",
      };
    }

    // ── 6a. Verify the message is actually in the DOM before clicking send ────
    const typedState = await getEditorState(activeEditorLocator);
    const typedTextNorm = normalizeEditableText(typedState.text);
    const messageNorm = normalizeEditableText(message);
    if (!typedTextNorm.includes(messageNorm)) {
      emit("error", "Typed message is not present in the active DM editor.");
      await diag.capture(page, "type-verify-failed");
      return {
        outcome: "failed",
        reason: "Typed message missing from DM editor before send",
      };
    }

    // ── 6a.1 ANTI-WRONG-RECIPIENT GUARD ──────────────────────────────────────
    // If the message we intended to send has a greeting name (e.g. "Hi Mike,"),
    // verify the editor does NOT contain a DIFFERENT greeting name. This catches
    // the case where a stale OS clipboard pasted "Hi Letrise..." into Mike's
    // composer AND the per-recipient guard in step 0a didn't fire (e.g. because
    // pageProfileName was null). It's the last line of defense before send.
    if (message) {
      const intendedGreeting = message.match(
        /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/i,
      );
      if (intendedGreeting) {
        const intendedName = intendedGreeting[1].toLowerCase();
        // Scan the editor text for any greeting addressed to a different name.
        const allGreetings = typedTextNorm.match(
          /(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/gi,
        );
        if (allGreetings) {
          for (const g of allGreetings) {
            const m = g.match(/([a-z]+)$/i);
            if (m) {
              const foundName = m[1].toLowerCase();
              if (foundName !== intendedName) {
                emit(
                  "error",
                  `WRONG-RECIPIENT BLOCK: editor contains greeting to "${foundName}" ` +
                    `but intended message greets "${intendedName}". Aborting send.`,
                );
                logger.error("LinkedIn DM wrong-recipient block at post-typing", {
                  profileUrl,
                  intendedName,
                  foundInEditor: foundName,
                  editorSnippet: typedTextNorm.slice(0, 80),
                });
                await diag.capture(page, "wrong-recipient-block");
                // Force-clear the editor so the next recipient doesn't inherit
                // the wrong draft.
                await forceClearDmDraft(page, activeEditorLocator).catch(() => {});
                return {
                  outcome: "failed",
                  reason: `Editor contained greeting to "${foundName}" but intended recipient is "${intendedName}". Send aborted by post-typing guard.`,
                };
              }
            }
          }
        }
      }
    }

    // ── 6b. Short settle for React to process the input event ─────────────────
    await humanDelay(400, 600);
    await diag.capture(page, "after-typing", { typedSnippet: messageSnippet(message) });

    // ── 7. Find and click the Send button ─────────────────────────────────────
    emit("info", "Looking for Send button...");

    let sendSuccessful = false;

    const SEND_BTN_POLL_TIMEOUT = 3000;
    const sendBtnPollDeadline = Date.now() + SEND_BTN_POLL_TIMEOUT;
    let sendBtnData = null;
    while (Date.now() < sendBtnPollDeadline) {
      sendBtnData = await findSendButtonForEditor(
        msgCtx,
        activeEditorLocator,
        emit,
      );
      if (sendBtnData && !sendBtnData.disabled) break;
      await humanDelay(120, 180);
    }

    if (sendBtnData && !sendBtnData.disabled) {
      emit("info", `Send button found and enabled, attempting click...`);
      sendSuccessful = await clickSendButtonRobust(
        page,
        sendBtnData.locator,
        activeEditorLocator,
      );
    } else {
      emit(
        "warn",
        "Send button not found or remains disabled. Falling back to Enter key.",
      );
    }
    await diag.capture(page, "send-button-search", {
      found: Boolean(sendBtnData),
      disabled: sendBtnData?.disabled,
      sendClicked: sendSuccessful,
    });

    // ── 7a. Keyboard Enter fallback ───────────────────────────────────────────
    if (!sendSuccessful) {
      emit("info", "Executing keyboard Enter fallback.");
      await ensureSelectionInEditor(activeEditorLocator);
      await humanDelay(150, 200);

      await page.keyboard.press("Enter").catch(() => {});
      await humanDelay(600, 900);

      const textAfterEnter = normalizeEditableText(
        await getEditableText(activeEditorLocator).catch(() => ""),
      );
      const snippet = normalizeEditableText(message).substring(0, 20);
      sendSuccessful = !textAfterEnter.includes(snippet);

      if (!sendSuccessful) {
        await ensureSelectionInEditor(activeEditorLocator);
        await page.keyboard.press("Control+Enter").catch(() => {});
        await humanDelay(400, 600);

        const textAfterCtrlEnter = normalizeEditableText(
          await getEditableText(activeEditorLocator).catch(() => ""),
        );
        sendSuccessful = !textAfterCtrlEnter.includes(snippet);
      }
    }

    await humanDelay(800, 1200);

    // ── 8. Verification — check error banner AND that editor cleared ───────────
    const verification = await verifyDmSent(page, activeEditorLocator, message);
    if (!verification.verified) {
      emit("error", `DM send failed: ${verification.reason}`);
      return { outcome: "failed", reason: verification.reason };
    }

    emit("info", `DM sent — moving to next profile.`);
    await page
      .evaluate(() => {
        window.__gtss_dm_outcome = "sent";
      })
      .catch(() => {});

    // ── 9. Navigate back to profile if we ended up on /messaging/ ─────────────
    const postSendUrl = page.url();
    if (
      postSendUrl.includes("/messaging/") ||
      postSendUrl.includes("/messages/")
    ) {
      emit("info", "Navigating back to profile after /messaging/ send...");
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await humanDelay(300, 500);
    }

    return { outcome: "sent" };
  } catch (err) {
    logger.error("LinkedIn DM Failed", { profileUrl, error: err.message });
    emit("error", `DM failed: ${err.message}`);
    await diag.capture(page, `failure-${err.message.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}`);
    return { outcome: "failed", reason: err.message };
  } finally {
    // Flush diagnostics for this DM attempt
    diag.flush(profileUrl);
    // Clean up ALL data-gtss-* tags regardless of outcome — run in both contexts
    const cleanupAttrs = async (ctx) => {
      await ctx
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
    };
    await cleanupAttrs(page);
    if (msgCtx && msgCtx !== page) {
      await cleanupAttrs(msgCtx).catch(() => {});
    }

    // CRITICAL CONTAINMENT FIX: Purge any dirty lingering UI states before releasing control.
    const executionOutcome = await page
      .evaluate(() => window.__gtss_dm_outcome)
      .catch(() => null);

    if (executionOutcome !== "sent") {
      logger.info(
        "Outreach pipeline flag marked unsafe. Forcing interface restoration...",
      );
      await dismissAllMessagingUI(page);
    }

    // Reset the page-level outcome flag for the next run
    await page
      .evaluate(() => {
        delete window.__gtss_dm_outcome;
      })
      .catch(() => {});
  }
}
/**
 * Like a recent post on the user's profile to warm them up.
 */
async function likeRecentPost(page, profileUrl, emit) {
  try {
    // LinkedIn post URLs often look like /in/username/recent-activity/all/
    const activityUrl = profileUrl.replace(/\/$/, "") + "/recent-activity/all/";
    emit("info", `Navigating to activity feed: ${activityUrl}`);

    await page.goto(activityUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);
    await humanScroll(page);

    // Look for posts
    // Note: LinkedIn changes classes frequently, these are approximate representations
    const likeMatch = await firstVisible(page, SELECTORS.unlikePost, 3000);

    if (!likeMatch) {
      emit("info", "No unliked posts found on the recent activity page.");
      return { outcome: "no_posts" };
    }

    emit(
      "info",
      `Found an unliked post (${likeMatch.selector}). Liking the most recent one...`,
    );

    // Scroll element into view
    await likeMatch.locator.scrollIntoViewIfNeeded();
    await humanDelay(1000, 2000);

    await likeMatch.locator.click();
    await humanDelay(2000, 3000);

    emit("info", "Successfully liked a recent post.");
    return { outcome: "liked" };
  } catch (err) {
    logger.error("LinkedIn Like Post Failed", {
      profileUrl,
      error: err.message,
    });
    emit("error", `Liking post failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest,
  sendDirectMessage,
  likeRecentPost,
  __private: {
    findProfileMessageAction,
    findBestDmEditor,
    findBestDmOverlay,
    activateDmEditor,
    typeFast,
    typeLikeHuman,
    pasteTextViaClipboard,
    setEditorTextWithDomEvents,
    forceClearDmDraft,
    waitForEditorText,
    findSendButtonForEditor,
    clickSendButtonRobust,
    waitForEditorInteractive,
    waitForDmEditor,
    detectMessagingBlocked,
    detectMessagingContext,
    dismissPremiumDialog,
  },
};

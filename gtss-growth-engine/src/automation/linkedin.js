const { humanDelay, humanScroll } = require("./browserBase");
const logger = require("../utils/logger");

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
    '.artdeco-modal:has-text("Premium")',
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
    "button.msg-form__send-button[aria-label]",
    'button[aria-label="Send"][type="submit"]',
    '.msg-form__send-btn-container button[type="submit"]',
    "button.msg-form__send-button",
    '.msg-overlay-conversation-bubble button[aria-label*="Send" i]',
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

  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      try {
        await candidate.waitFor({
          state: "visible",
          timeout: Math.min(300, remaining),
        });
        return {
          locator: candidate,
          selector: count > 1 ? `${selector} >> nth=${index}` : selector,
        };
      } catch (_) {
        // Try the next matching candidate.
      }
    }
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
          const maxY = Math.max(620, viewportHeight * 0.82);
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
async function waitForEditorInteractive(page, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const interactive = await page
      .evaluate(() => {
        const editors = document.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"],' +
            '.msg-form [contenteditable="true"]',
        );
        for (const el of editors) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            rect.width > 20 &&
            rect.height > 20 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.pointerEvents !== "none" &&
            Number(style.opacity || "1") > 0.5 &&
            !el.disabled &&
            el.getAttribute("aria-disabled") !== "true"
          )
            return true;
        }
        return false;
      })
      .catch(() => false);
    if (interactive) return true;
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

async function detectPremiumRequired(page) {
  // 800 ms is enough — the dialog is already rendered by the time we check.
  // Skip innerText() and closeOverlay() — we are navigating away immediately,
  // so there is no point spending another ~1 s cleaning up the popup.
  const premiumMatch = await firstVisible(page, SELECTORS.premiumDialog, 800);
  if (!premiumMatch) return null;

  return {
    outcome: "premium_required",
    reason: "LinkedIn Premium required to message this profile",
  };
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

/**
 * Fast post-send verification.
 *
 * After clicking Send we wait 500 ms and look for an explicit LinkedIn error
 * banner.  If none appears we assume success and move on.  The old approach
 * polled for up to 8 seconds (10 × 800 ms) waiting for the message to appear
 * in the thread — that was a large unnecessary cost per profile.
 */
async function verifyDmSent(page) {
  await humanDelay(500, 600);
  const warning = await detectActionWarning(page);
  if (warning) {
    return { verified: false, reason: `LinkedIn warning: ${warning}` };
  }
  return { verified: true, reason: "No error banner — assumed sent" };
}

async function getEditableText(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      if (tagName === "textarea" || tagName === "input")
        return String(el.value || "");
      return String(el.textContent || el.innerText || "");
    })
    .catch(() => "");
}

/**
 * Activate LinkedIn's DM composer so it truly has keyboard focus.
 *
 * LinkedIn's contenteditable uses React synthetic events AND pointer events.
 * A plain Playwright click() or el.focus() is often insufficient — the editor
 * becomes "visible" but its internal React focus state doesn't fire, so
 * subsequent keyboard input is silently dropped.  We fix this with:
 *
 *   1. Playwright native locator.focus() — sends a CDP AccessibilityNode.focus
 *      command which sets OS-level focus independently of pointer events.
 *   2. locator.click({ force: true }) — moves the cursor position for React.
 *   3. Full pointer event sequence (pointerdown→mousedown→focusin→pointerup→
 *      mouseup→click) dispatched via evaluate so React's SyntheticEvent system
 *      also registers the interaction. LinkedIn's editor uses onPointerDown,
 *      not just onMouseDown, so skipping pointer events breaks its handler.
 *   4. Coordinate-based page.mouse.click() fallback when the locator is stale
 *      (e.g. after a React re-render wiped the data-gtss-dm-editor attribute).
 *   5. Fresh-editor re-discovery when the locator matches nothing at all.
 *   6. The entire sequence retries up to MAX_FOCUS_ATTEMPTS times.
 */
async function activateDmEditor(page, locator) {
  const MAX_FOCUS_ATTEMPTS = 1;

  for (let attempt = 1; attempt <= MAX_FOCUS_ATTEMPTS; attempt++) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(60, 120);

    // Step 1: Playwright native focus (CDP AccessibilityNode.focus).
    // This bypasses pointer-event guards and focus-trap JS that may block
    // regular click-based focus during LinkedIn's modal animation.
    await locator.focus().catch(() => {});
    await humanDelay(40, 80);

    // Step 2: OS-level click via Playwright (establishes cursor position)
    await locator.click({ force: true }).catch(() => {});
    await humanDelay(60, 100);

    // Step 3: Full React synthetic event sequence including pointer events.
    // LinkedIn's DM editor registers onPointerDown before onMouseDown; firing
    // only mousedown/click is not enough to trigger its internal focus handler.
    const focusedAfterReact = await locator
      .evaluate((el) => {
        const opts = { bubbles: true, cancelable: true, view: window };
        const pOpts = { ...opts, pointerId: 1, pointerType: "mouse" };
        el.dispatchEvent(new PointerEvent("pointerover", pOpts));
        el.dispatchEvent(
          new PointerEvent("pointerenter", { ...pOpts, bubbles: false }),
        );
        el.dispatchEvent(new PointerEvent("pointerdown", pOpts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new FocusEvent("focus", { ...opts, bubbles: false }));
        el.dispatchEvent(new FocusEvent("focusin", opts));
        el.dispatchEvent(new PointerEvent("pointerup", pOpts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
        el.focus({ preventScroll: false });
        return (
          document.activeElement === el || el.contains(document.activeElement)
        );
      })
      .catch(() => false);

    if (focusedAfterReact) {
      await humanDelay(100, 200);
      return; // Focus successfully landed — done.
    }

    // Step 4: Coordinate-based fallback.
    // When the locator's data-gtss-* attribute was wiped by a React re-render,
    // evaluate() throws (0 matching elements) and is caught above as false.
    // page.mouse.click() with explicit coordinates still works because it hits
    // whatever DOM node is visually at that position — including the fresh node.
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height * 0.4; // slightly above centre feels natural
      await page.mouse.move(
        cx + (Math.random() - 0.5) * 8,
        cy + (Math.random() - 0.5) * 4,
      );
      await humanDelay(30, 60);
      await page.mouse.click(cx, cy);
      await humanDelay(60, 120);

      const focusedAfterMouse = await locator
        .evaluate(
          (el) =>
            document.activeElement === el ||
            el.contains(document.activeElement),
        )
        .catch(() => false);

      if (focusedAfterMouse) {
        await humanDelay(100, 180);
        return;
      }
    }

    // Step 5: Re-discover a fresh stable editor.
    // If the original locator is completely stale (zero matching elements,
    // null bounding box) we re-query using LinkedIn's own stable class name
    // and focus that fresh element before retrying.
    const freshEditor = page
      .locator('.msg-form__contenteditable[contenteditable="true"]')
      .last();
    const freshVisible = await freshEditor
      .isVisible({ timeout: 800 })
      .catch(() => false);
    if (freshVisible) {
      await freshEditor.focus().catch(() => {});
      await humanDelay(60, 100);
      await freshEditor.click({ force: true }).catch(() => {});
      await humanDelay(60, 100);
      const freshFocused = await freshEditor
        .evaluate(
          (el) =>
            document.activeElement === el ||
            el.contains(document.activeElement),
        )
        .catch(() => false);
      if (freshFocused) {
        await humanDelay(100, 180);
        return;
      }
    }

    if (attempt < MAX_FOCUS_ATTEMPTS) {
      await humanDelay(200 * attempt, 320 * attempt);
    }
  }

  // Final fallback: click the overlay container to give it OS focus, then
  // call el.focus() directly. This covers edge cases where all CDP and
  // coordinate paths are blocked (e.g. overlapping modal shields).
  await page
    .locator(".msg-form, .msg-overlay-conversation-bubble")
    .last()
    .click({ force: true })
    .catch(() => {});
  await humanDelay(80, 150);
  await locator.evaluate((el) => el.focus()).catch(() => {});
  await humanDelay(150, 250); // let React finish its focus handler
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

  // One click to land focus — no event flooding, no pointer-event sequence.
  await locator.click({ force: true }).catch(() => {});
  await humanDelay(60, 100);

  // fill() is a single atomic DOM operation and fires the input/change events
  // that React's synthetic event system needs to enable the Send button.
  const filled = await locator
    .fill(value)
    .then(() => true)
    .catch(() => false);

  if (!filled) {
    // insertText fires a proper InputEvent (bubbles: true, inputType: insertText)
    // which React can observe — works on contenteditable nodes that reject fill().
    await page.keyboard.insertText(value).catch(() => {});
  }

  await humanDelay(60, 100);

  // Quick sanity check — did any text land?
  const landed = await getEditableText(locator)
    .then((t) => t.trim().length > 0)
    .catch(() => false);

  return landed;
}

/**
 * Human-like message entry for LinkedIn's DM composer.
 *
 * Uses Playwright's pressSequentially() which fires proper keydown/keypress/
 * keyup/input events for each character — identical to real typing from the
 * browser's perspective.  React's synthetic event system reads these natively
 * so the send button becomes enabled reliably.
 *
 * Default 18 ms/char ≈ 56 WPM — clearly human-paced and ~6× faster than the
 * previous 40-140 ms per-character loop.  Set TYPING_DELAY_MS env var to
 * override (e.g. TYPING_DELAY_MS=8 for fast dev runs).
 *
 * Falls back to document.execCommand('insertText') if pressSequentially
 * doesn't land (rare edge case in some LinkedIn overlay variants).
 */
async function typeLikeHuman(page, locatorOrSelector, text) {
  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector).first()
      : locatorOrSelector;
  const expected = String(text || "").trim();

  // Step 1: Properly activate the editor (fixes the "open but can't type" bug)
  await activateDmEditor(page, locator);

  // Step 1b: Verify focus actually landed on the editor before we start typing.
  // If focus silently failed (landed on a different element or nowhere),
  // Control+A and subsequent key presses would operate on the wrong element —
  // e.g. wiping the recipient field or being swallowed by the page.
  const focusLanded = await locator
    .evaluate(
      (el) =>
        document.activeElement === el || el.contains(document.activeElement),
    )
    .catch(() => false);

  if (!focusLanded) {
    // Make one more direct attempt via the stable selector before giving up.
    const stableFresh = page
      .locator('.msg-form__contenteditable[contenteditable="true"]')
      .last();
    const freshVisible = await stableFresh
      .isVisible({ timeout: 600 })
      .catch(() => false);
    if (freshVisible) {
      await activateDmEditor(page, stableFresh);
      // Re-point our local reference for the rest of the function.
      return typeLikeHuman(page, stableFresh, text);
    }
    throw new Error(
      "LinkedIn DM editor focus verification failed — document.activeElement is not the message composer. " +
        "The editor may have been obscured by a modal overlay or LinkedIn re-rendered the composer tree.",
    );
  }

  // Step 2: Clear any pre-existing placeholder/text
  await page.keyboard
    .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    .catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  await humanDelay(40, 80);

  // Step 3: pressSequentially fires proper keyboard events React can handle.
  // It also calls locator.focus() internally, which is an additional safety net.
  const speedup = process.env.TEST_SPEEDUP === "true";
  const charDelay = speedup ? 0 : Number(process.env.TYPING_DELAY_MS || 18);
  await locator.pressSequentially(text, { delay: charDelay });
  await humanDelay(60, 120); // brief settle before verification

  // Step 4: Verify text landed; fall back to execCommand if not
  let actual = (await getEditableText(locator)).trim();
  if (!actual.includes(expected)) {
    // Re-activate so focus is clean before the fallback
    await activateDmEditor(page, locator);
    await page.keyboard
      .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
      .catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await humanDelay(40, 80);

    await locator.evaluate((el, value) => {
      el.focus();
      // document.execCommand('insertText') fires the same DOM events as real
      // keyboard typing, including React's synthetic InputEvent handler.
      if (typeof document.execCommand === "function") {
        document.execCommand("selectAll", false, undefined);
        document.execCommand("insertText", false, value);
      } else {
        // Absolute last resort for browsers that dropped execCommand support
        const tagName = String(el.tagName || "").toLowerCase();
        if (tagName === "textarea" || tagName === "input") {
          el.value = value;
        } else {
          el.textContent = value;
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value,
          }),
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, text);

    actual = (await getEditableText(locator)).trim();
  }

  if (!actual.includes(expected)) {
    throw new Error("LinkedIn message editor did not accept typed text");
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
    await connectMatch.locator.click();
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
 * Send a Direct Message on LinkedIn to a 1st-degree connection.
 *
 * Throughput-optimised flow:
 *   navigate → [profile name verify] → message button? no → skip
 *             ↓ yes
 *           click → premium popup? yes → skip
 *             ↓ no
 *           find editor (1 attempt) → not found → skip
 *             ↓ found
 *           typeFast (fill) → find send button → click / keyboard shortcut
 *             ↓
 *           wait 500 ms → error banner? → fail / assume sent → next profile
 *
 * No recovery loops, no multi-attempt focus, no 8-second verification polling.
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
  try {
    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(300, 600);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(80, 200);

    // ── 0. Profile identity verification ─────────────────────────────────────
    // When a leadName is provided, scrape the visible <h1> on the profile page
    // and compare first names.  A mismatch means the browser landed on the wrong
    // profile — stale tab state, a redirect, or a URL stored with a different
    // person's path.  We abort before typing a single character to prevent the
    // wrong person from receiving this DM.
    if (leadName) {
      try {
        const pageH1 = await page
          .locator("h1.text-heading-xlarge, main h1")
          .first()
          .textContent({ timeout: 2500 })
          .catch(() => null);

        if (pageH1) {
          // Normalise: lowercase, keep only letters (handles accents, hyphens)
          const normalise = (name) =>
            String(name || "")
              .trim()
              .split(/\s+/)[0]
              .toLowerCase()
              .replace(/[^a-z]/g, "");

          const pageFirst = normalise(pageH1);
          const expectedFirst = normalise(leadName);

          if (pageFirst && expectedFirst && pageFirst !== expectedFirst) {
            emit(
              "error",
              `Profile identity mismatch: page shows "${pageH1.trim()}" ` +
                `but expected "${leadName}". Aborting to prevent wrong-person DM.`,
            );
            logger.error("LinkedIn DM Safety Block", {
              profileUrl,
              expectedLeadName: leadName,
              pageProfileName: pageH1.trim(),
            });
            return {
              outcome: "failed",
              reason:
                `Profile name mismatch: page="${pageH1.trim()}" vs expected="${leadName}". ` +
                `Send aborted by identity guard.`,
            };
          }

          emit(
            "info",
            `Profile identity verified: "${pageH1.trim()}" matches lead "${leadName}".`,
          );
        }
      } catch (verifyErr) {
        // Non-fatal: the name check in dmQueue.js is the primary safety gate.
        // If we can't read the page h1 (network hiccup, selector change, etc.)
        // we warn and continue rather than blocking every send.
        emit(
          "warn",
          `Could not verify profile name from page — proceeding. (${verifyErr.message})`,
        );
      }
    }

    // ── 1. Message button — no button means not connected; skip immediately ──
    const messageMatch = await findProfileAction(
      page,
      SELECTORS.message,
      "Message",
      1200,
    );
    if (!messageMatch) {
      emit("warn", "No Message button — skipping profile.");
      return {
        outcome: "not_connected",
        reason: "Message button not visible — not a 1st-degree connection",
      };
    }

    // ── 2. Click Message ─────────────────────────────────────────────────────
    emit("info", `Clicking Message (${messageMatch.selector})...`);
    await messageMatch.locator.click();
    // Reduced from 700–1200 ms: 400–600 ms is enough for the overlay to mount.
    await humanDelay(400, 600);

    // ── 3. Premium popup — detected within 800 ms, skip immediately ─────────
    const premiumRequired = await detectPremiumRequired(page);
    if (premiumRequired) {
      emit("warn", premiumRequired.reason);
      return premiumRequired;
    }

    // ── 4. Wait for editor to be interactive — short ceiling, then move on ──
    // Reduced from 2500 ms to 800 ms.  If the animation hasn't finished by
    // then the profile is unusually slow and we skip rather than babysit it.
    await waitForEditorInteractive(page, 800);

    // ── 5. Locate DM editor — single attempt ────────────────────────────────
    const editorMatch = await waitForDmEditor(page, null, 1);
    if (!editorMatch) {
      emit("warn", "DM editor not found — skipping profile.");
      return { outcome: "failed", reason: "DM editor not found" };
    }

    // Prefer LinkedIn's own stable class over the token-based locator —
    // it survives React re-renders between discovery and interaction.
    const stableLocator = page
      .locator('.msg-form__contenteditable[contenteditable="true"]')
      .last();
    const useStable = await stableLocator
      .isVisible({ timeout: 300 })
      .catch(() => false);
    const activeEditorLocator = useStable ? stableLocator : editorMatch.locator;

    // ── 6. Type message — fast fill, not per-character simulation ───────────
    emit("info", "Typing message (fast fill)...");
    const textLanded = await typeFast(page, activeEditorLocator, message);
    if (!textLanded) {
      emit("warn", "Message text did not land in editor — skipping profile.");
      return { outcome: "failed", reason: "Text entry failed" };
    }
    await humanDelay(100, 200);

    // ── 7. Send ──────────────────────────────────────────────────────────────
    const sendMatch = await firstVisible(page, SELECTORS.dmSend, 700);
    if (
      sendMatch &&
      !(await sendMatch.locator.isDisabled().catch(() => false))
    ) {
      emit("info", `Clicking Send (${sendMatch.selector})...`);
      await sendMatch.locator.click();
    } else {
      // Keyboard shortcut fallback — no extra activateDmEditor round-trip.
      const sendShortcut =
        process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
      emit("info", `Send button not ready — using ${sendShortcut}...`);
      await page.keyboard.press(sendShortcut);
    }

    // ── 8. Fast verification — 500 ms wait + single error banner check ───────
    const verification = await verifyDmSent(page);
    if (!verification.verified) {
      emit("error", `DM send failed: ${verification.reason}`);
      return { outcome: "failed", reason: verification.reason };
    }

    emit("info", `DM sent (${verification.reason}) — moving to next profile.`);
    return { outcome: "sent" };
  } catch (err) {
    logger.error("LinkedIn DM Failed", { profileUrl, error: err.message });
    emit("error", `DM failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
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
    findBestDmEditor,
    findBestDmOverlay,
    activateDmEditor,
    typeFast,
    typeLikeHuman,
    waitForEditorInteractive,
    waitForDmEditor,
  },
};

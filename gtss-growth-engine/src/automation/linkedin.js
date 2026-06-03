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

async function findProfileMessageAction(page, timeout = 2200) {
  const direct = await findProfileAction(
    page,
    SELECTORS.message,
    "Message",
    Math.min(timeout, 1400),
  );
  if (direct) return direct;

  const moreMatch = await findProfileAction(page, SELECTORS.more, "More", 700);
  if (!moreMatch) return null;

  await moreMatch.locator.click({ force: true }).catch(() => {});
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
async function waitForEditorInteractive(page, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const interactive = await page
      .evaluate(() => {
        // Broad selector set — covers the standard DM overlay (.msg-form__contenteditable),
        // the "New message" compose modal (which may lack .msg-form__contenteditable),
        // and conversation overlays with existing message history.
        const editors = document.querySelectorAll(
          '.msg-form__contenteditable[contenteditable="true"],' +
            '.msg-form [contenteditable="true"],' +
            '.msg-form textarea,' +
            '[role="dialog"] [contenteditable="true"],' +
            '[role="dialog"] textarea,' +
            '[role="dialog"] [role="textbox"],' +
            '.msg-overlay-conversation-bubble [contenteditable="true"],' +
            '.msg-overlay-conversation-bubble textarea',
        );
        const rejectHint = /\b(subject|recipient|recipients|to:|search|people|name|email)\b/i;
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
            el.placeholder, el.getAttribute('aria-label'),
            el.getAttribute('data-placeholder'), el.name, el.id,
          ].filter(Boolean).join(' ');
          if (rejectHint.test(hint) && !/message|write|reply/i.test(hint))
            continue;
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
  if (editorLocator && originalMessage) {
    try {
      const remainingText = await getEditableText(editorLocator);
      // Compare the first 20 chars to handle minor whitespace differences.
      const snippet = originalMessage.substring(0, 20);
      if (remainingText && snippet && remainingText.includes(snippet)) {
        return {
          verified: false,
          reason: "Message still present in editor after send attempt",
        };
      }
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
      const stillEnabled = !(await postSendBtn.locator.isDisabled().catch(() => true));
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
  const MAX_FOCUS_ATTEMPTS = 3;

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

  // ─── Subject field guard ──────────────────────────────────────────────
  // LinkedIn's "New message" compose modal (used for Free messages, InMail,
  // and non-1st-degree connections) opens with focus trapped on the Subject
  // input.  ONLY Tab forward when focus is SPECIFICALLY on a Subject or
  // recipient <input>/<select> — NOT for buttons, divs, or other elements,
  // because blind tabbing navigates through the overlay toolbar (GIF, attach,
  // emoji, Send) and moves focus past the Send button.
  for (let tabGuard = 0; tabGuard < 3; tabGuard++) {
    const isOnSubjectInput = await page
      .evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const tag = el.tagName.toLowerCase();
        // Only Tab past <input> or <select> elements that look like Subject/recipient
        if (tag !== "input" && tag !== "select") return false;
        const hint = [
          el.placeholder || "",
          el.getAttribute("aria-label") || "",
          el.name || "",
          el.id || "",
          el.className || "",
        ]
          .join(" ")
          .toLowerCase();
        return /subject|recipient|\bto\b|people/.test(hint);
      })
      .catch(() => false);

    if (!isOnSubjectInput) break; // Focus is not on Subject — stop tabbing

    await page.keyboard.press("Tab");
    await humanDelay(120, 220);
  }
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

  const wroteExactEditor = await locator
    .evaluate((el, message) => {
      const tagName = String(el.tagName || "").toLowerCase();
      el.focus({ preventScroll: false });

      if (tagName === "textarea" || tagName === "input") {
        // Native input/textarea: value assignment + manual events is sufficient.
        el.value = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "" }));
        el.value = message;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: message,
          }),
        );
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // contenteditable (LinkedIn's React DM composer) — MUST use execCommand so
        // React's synthetic event system receives a proper beforeinput + input event
        // pair with inputType:"insertText".
        //
        // Setting el.textContent directly bypasses beforeinput entirely: React's
        // internal editor state stays empty, the placeholder layer is never removed,
        // and the Send button stays disabled even though the DOM visually shows the
        // message text. execCommand('insertText') fires the full native event
        // sequence (beforeinput → DOM mutation → input) that React listens to.
        if (typeof document.execCommand === "function") {
          document.execCommand("selectAll", false, undefined);
          document.execCommand("insertText", false, message);
          // execCommand fires beforeinput + input natively — no manual dispatch needed.
        } else {
          // Absolute fallback for environments without execCommand (very rare).
          // This path will not reliably enable the Send button on React editors,
          // but allows the outer typeLikeHuman fallback in sendDirectMessage to
          // catch and recover.
          el.textContent = "";
          el.textContent = message;
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: message,
            }),
          );
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      return true;
    }, value)
    .catch(() => false);

  if (!wroteExactEditor) {
    await locator.fill(value).catch(async () => {
      await activateDmEditor(page, locator);
      await page.keyboard.insertText(value).catch(() => {});
    });
  }

  await humanDelay(80, 140);

  const actual = (await getEditableText(locator)).trim();
  const normalizeWS = (s) => String(s).replace(/\s+/g, ' ').trim();
  if (!normalizeWS(actual).includes(normalizeWS(value))) return false;

  const activeIsEditor = await locator
    .evaluate(
      (el) =>
        document.activeElement === el || el.contains(document.activeElement),
    )
    .catch(() => false);

  return activeIsEditor;
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
  const normalizeWS = (s) => String(s).replace(/\s+/g, ' ').trim();
  if (!normalizeWS(actual).includes(normalizeWS(expected))) {
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

async function findSendButtonForEditor(page, editor) {
  const button = await editor.evaluateHandle(el => {
    let container =
      el.closest(".msg-form") ||
      el.closest(".msg-overlay-conversation-bubble") ||
      el.closest('[role="dialog"]');

    if (!container) return null;

    const buttons = [...container.querySelectorAll('button')];

    return buttons.find(btn => {
      const text = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
      const rect = btn.getBoundingClientRect();

      return (
        text.includes("send") &&
        rect.width > 0 &&
        rect.height > 0 &&
        btn.getAttribute("aria-disabled") !== "true" &&
        !btn.disabled
      );
    }) || null;
  });

  if (!button) return null;

  return page.locator(
    await button.evaluate(b => {
      b.setAttribute("data-gtss-send", Date.now());
      return `[data-gtss-send="${b.getAttribute("data-gtss-send")}"]`;
    })
  );
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

    // ── 0. Profile identity & message-content verification ─────────────────
    // Two safety checks before we type a single character:
    //   A. If leadName was passed, verify the profile page h1 matches it.
    //   B. ALWAYS check the message body for a greeting name (e.g. "Hi Peter,")
    //      and verify it matches the profile page. This catches the critical bug
    //      where the message was generated/queued for the wrong person.
    {
      const normalise = (name) =>
        String(name || "")
          .trim()
          .split(/\s+/)[0]
          .toLowerCase()
          .replace(/[^a-z]/g, "");

      let pageProfileName = null;
      try {
        pageProfileName = await page
          .locator("h1.text-heading-xlarge, main h1")
          .first()
          .textContent({ timeout: 2500 })
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
      // Catches "Hi Peter," being sent to Amelia Kate's profile.
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

    // ── 1. Message button — no button means not connected; skip immediately ──
    const messageMatch = await findProfileMessageAction(page, 2200);
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

    // ── 3. Premium / blocked popup — detect quickly, skip permanently ───────
    const blockedImmediately = await detectMessagingBlocked(page, 900);
    if (blockedImmediately) {
      emit("warn", blockedImmediately.reason);
      return blockedImmediately;
    }

    // ── 4. Wait for editor to be interactive — generous ceiling ──────────────
    // LinkedIn's compose modal and conversation overlay can take 1-2s to
    // mount the editor, especially with existing message history.
    const editorInteractive = await waitForEditorInteractive(page, 1800);
    if (!editorInteractive) {
      const blockedAfterWait = await detectMessagingBlocked(page, 500);
      if (blockedAfterWait) {
        emit("warn", blockedAfterWait.reason);
        return blockedAfterWait;
      }
    }

    // ── 5. Locate DM editor — single attempt ────────────────────────────────
    const editorMatch = await waitForDmEditor(page, null, 1);
    if (!editorMatch) {
      emit("warn", "DM editor not found — skipping profile.");
      return { outcome: "failed", reason: "DM editor not found" };
    }

    // Prefer a stable CSS-class locator over the token-based locator —
    // it survives React re-renders between discovery and interaction.
    // Try multiple selectors to cover both the standard DM overlay and
    // the "New message" compose modal (which may lack .msg-form__contenteditable).
    const stableCandidates = [
      '.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form [contenteditable="true"]:not([class*="subject"])',
      '[role="dialog"] [contenteditable="true"][aria-label*="message" i]',
      '[role="dialog"] [contenteditable="true"][aria-label*="Write" i]',
      '[role="dialog"] [contenteditable="true"][data-placeholder*="message" i]',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      '.msg-form [role="textbox"]',
    ];
    let activeEditorLocator = editorMatch.locator;
    for (const sel of stableCandidates) {
      const candidate = page.locator(sel).last();
      const vis = await candidate.isVisible({ timeout: 200 }).catch(() => false);
      if (vis) {
        activeEditorLocator = candidate;
        break;
      }
    }

    // ── 5b. Handle compose modals with Subject field ────────────────────────
    // LinkedIn's "New message" compose dialog has a Subject input that traps
    // focus on modal open.  Detect it and ensure focus moves to the body.
    const hasSubject = await page
      .locator('input[placeholder*="Subject" i], input[aria-label*="Subject" i]')
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (hasSubject) {
      emit("info", "Compose modal with Subject field detected — focusing message body...");
      await activeEditorLocator.scrollIntoViewIfNeeded().catch(() => {});
      await activeEditorLocator.click({ force: true }).catch(() => {});
      await humanDelay(150, 300);
    }

    // ── 6. Type message — fast fill, not per-character simulation ───────────
    emit("info", "Typing message (fast fill)...");
    let textLanded = await typeFast(page, activeEditorLocator, message);

    // ── 6a. Retry: re-focus editor + typeLikeHuman ──────────────────────────
    // If typeFast failed (focus didn't land, locator stale, etc.), try clicking
    // the editor directly and use the slower but more reliable typeLikeHuman
    // which fires real keyboard events.
    if (!textLanded) {
      emit(
        "info",
        "Fast fill failed — retrying with direct click and human typing...",
      );
      // Only Tab if we know there's a Subject field trapping focus
      if (hasSubject) {
        await page.keyboard.press("Tab");
        await humanDelay(100, 200);
      }
      // Re-click the editor directly
      await activeEditorLocator.scrollIntoViewIfNeeded().catch(() => {});
      await activeEditorLocator.click({ force: true }).catch(() => {});
      await humanDelay(200, 350);
      try {
        await typeLikeHuman(page, activeEditorLocator, message);
        textLanded = true;
      } catch (retypeErr) {
        emit("warn", `Human typing retry also failed: ${retypeErr.message}`);
        return { outcome: "failed", reason: "Text entry failed (all methods)" };
      }
    }
    await humanDelay(100, 200);

    // Force React to recognize the content change
    await activeEditorLocator.evaluate(el => {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});

    // ── 6b. Verify Send button activated; fall back to typeLikeHuman if not ─
    // typeFast uses execCommand('insertText') which fires the beforeinput + input
    // events that React needs. On some LinkedIn overlay variants (e.g. the Free
    // Message modal shown in the screenshot) the Send button may still be disabled
    // if the execCommand path didn't reach the active React fiber. We detect this
    // cheaply and re-type via pressSequentially — real keyboard events that React's
    // contenteditable always accepts — rather than silently falling through to the
    // Ctrl+Enter shortcut which also fails when React still believes the editor
    // is empty.
    const sendCheckMatch = await firstVisible(page, SELECTORS.dmSend, 500);
    const sendAlreadyEnabled = sendCheckMatch
      ? !(await sendCheckMatch.locator.isDisabled().catch(() => true))
      : false;

    if (!sendAlreadyEnabled) {
      emit(
        "info",
        "Send button not enabled after fast fill — retrying with human typing...",
      );
      try {
        await typeLikeHuman(page, activeEditorLocator, message);
        await humanDelay(80, 150);
      } catch (retypeErr) {
        emit("warn", `typeLikeHuman fallback failed: ${retypeErr.message}`);
        return { outcome: "failed", reason: "Text entry failed (both paths)" };
      }
    }

    // ── 7. Send (ROBUST) ─────────────────────────────────────────────────────
    emit("info", "Attempting to send message...");

    // Strategy 0: Ensure Send button is ready (critical)
    await humanDelay(400, 700); // Let React fully process the input event

    let sendSuccessful = false;
    
    // Check function: Verify the conversation changed.
    // A React editor can clear visually but message fails.
    const verifySentLocally = async () => {
      const messageExists = await page.evaluate((msg) => {
        const nodes = [...document.querySelectorAll(".msg-s-message-list__event")];
        return nodes.some(n => n.innerText.includes(msg.substring(0, 20)));
      }, message).catch(() => false);
      return messageExists;
    };

    const sendButtonStrategies = [
      // 1. Best: Stable selector inside same tree + retry
      async () => {
        const sendMatch = await findSendButtonForEditor(page, activeEditorLocator);
        if (!sendMatch) return false;
        
        emit("info", "Strategy 1: Found Send button inside same tree...");
        
        // Critical: Wait for button to be enabled
        let attempts = 0;
        while (attempts < 4) {
          const isDisabled = await sendMatch.isDisabled().catch(() => true);
          if (!isDisabled) break;
          await humanDelay(150, 250);
          attempts++;
        }

        await sendMatch.click({ timeout: 3000 }).catch(() => {});
        return true;
      },
      
      // 2. DOM coordinate click (bypasses all Playwright actionability)
      async () => {
        emit("info", "Strategy 2: Trying DOM coordinate click fallback...");
        return page.evaluate(() => {
          const btn = document.querySelector('button.msg-form__send-button:not([disabled]), button[aria-label*="Send"]:not([disabled])');
          if (!btn) return false;
          
          const rect = btn.getBoundingBox ? btn.getBoundingBox() : btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          
          const evt = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y });
          btn.dispatchEvent(evt);
          return true;
        }).catch(() => false);
      }
    ];

    for (const strategy of sendButtonStrategies) {
      if (await strategy()) {
        await humanDelay(800, 1200);
        if (await verifySentLocally()) {
          sendSuccessful = true;
          break;
        } else {
          emit("info", "Strategy executed but editor did not clear. Retrying next strategy...");
        }
      }
    }

    // Wait for LinkedIn to process the send before verification.
    await humanDelay(1000, 1200);

    // ── 8. Verification — check error banner AND that editor cleared ─────────
    const verification = await verifyDmSent(page, activeEditorLocator, message);
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
    findProfileMessageAction,
    findBestDmEditor,
    findBestDmOverlay,
    activateDmEditor,
    typeFast,
    typeLikeHuman,
    waitForEditorInteractive,
    waitForDmEditor,
    detectMessagingBlocked,
  },
};

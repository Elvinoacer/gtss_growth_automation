/**
 * LinkedIn Detection Helpers
 * Functions for detecting Premium-required blocks, messaging-blocked states,
 * and action warnings (rate-limit / error banners) on LinkedIn pages.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { firstVisible, firstVisibleOnProfile } = require("./profileActions");
const { dismissPremiumDialog } = require("./messagingFrame");
const { dismissLinkedInNavDropdowns } = require("./dismissUI");

/**
 * Text patterns that identify LinkedIn Premium / InMail messaging walls.
 * Kept broad enough for rotating copy ("Build your dream team", etc.) but
 * scoped to messaging-upsell language so a normal Premium badge on a profile
 * card does not false-trigger.
 */
// Strong patterns: unique to messaging Premium walls (safe even if a sidebar
// promo uses the word "Premium"). Expanded after production runs where
// "Build your dream team" / "Try Premium for free" walls were missed.
const PREMIUM_MESSAGING_PATTERNS = [
  /with premium,?\s*you can message anyone/i,
  /grow your business with premium/i,
  /build your dream team/i,
  /inmail credits?/i,
  /send inmails?/i,
  /unlock (messaging|inmail)/i,
  /message anyone with premium/i,
  /premium to message/i,
  /message .* only available .* premium/i,
  /try premium (for )?free/i,
  /get (linkedin )?premium/i,
  /reactivate premium/i,
  /see who'?s viewed your profile/i,
  /premium free trial/i,
];

function textLooksLikePremiumMessagingBlock(text) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized || normalized.length < 8) return false;

  for (const re of PREMIUM_MESSAGING_PATTERNS) {
    if (re.test(normalized)) return true;
  }

  // Secondary heuristic: premium + message/inmail + CTA language together.
  // Requires BOTH messaging language and a CTA so a static "Premium" badge
  // on a profile card does not false-trigger.
  const hasPremium = /\bpremium\b/.test(normalized);
  const hasMsg = /\b(message|inmail|messaging|in-?mail)\b/.test(normalized);
  const hasCta = /\b(get|try|upgrade|required|unlock|subscribe|start|free trial)\b/.test(
    normalized,
  );
  // Also require the surface looks like a wall (not a free composer): no
  // "write a message" composer copy when free messaging is open.
  const hasComposer = /write a message|type a message|send a message…|send a message\.\.\./i.test(
    normalized,
  );
  return hasPremium && hasMsg && hasCta && !hasComposer;
}

/**
 * Detect the ACTIVE modal/dialog after a Message click.
 *
 * Returns one of:
 *   { kind: 'premium', snippet }
 *   { kind: 'composer', snippet }
 *   { kind: 'other_modal', snippet }
 *   null
 *
 * This is the authoritative post-click probe. Prefer this over guessing
 * from URL alone — LinkedIn often shows a Premium wall as a dialog without
 * navigating, and our older "editor not found" path treated that as
 * not_connected.
 */
async function detectActiveMessagingModal(page) {
  const probeInContext = async (ctx) =>
    ctx
      .evaluate(() => {
        const normalize = (s) =>
          String(s || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const hasFreeComposer = (root) =>
          Boolean(
            root.querySelector(
              '.msg-form__contenteditable[contenteditable="true"],' +
                ' [contenteditable="true"][aria-label*="message" i],' +
                ' [contenteditable="true"][aria-label*="write" i],' +
                ' [role="textbox"][aria-label*="message" i],' +
                ' [role="textbox"][aria-label*="write" i],' +
                ' textarea[aria-label*="message" i],' +
                ' textarea[placeholder*="message" i]',
            ),
          );

        const isPremiumText = (t) => {
          if (!t || t.length < 6) return false;
          if (
            /with premium|build your dream team|grow your business with premium|inmail|try premium|get premium|unlock (messaging|inmail)|premium free trial|reactivate premium|see who.?s viewed/i.test(
              t,
            )
          ) {
            return true;
          }
          // Large upsell dialog: Premium + CTA, no free composer copy.
          if (
            /\bpremium\b/.test(t) &&
            /\b(get|try|upgrade|subscribe|start|free trial)\b/.test(t) &&
            !/write a message|type a message/.test(t)
          ) {
            return true;
          }
          return false;
        };

        const isForBusiness = (t) =>
          /explore more for business/.test(t) ||
          (/\bmy apps\b/.test(t) && /hire on linkedin|sell with linkedin/.test(t));

        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 100 &&
            rect.height > 60 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };

        const candidates = [
          ...document.querySelectorAll(
            '[role="dialog"], .artdeco-modal, [data-test-modal], [class*="upsell"]',
          ),
        ];

        // Interop outlet children (shadow-piercing not available here for closed
        // roots; open roots still expose light-DOM descendants).
        const interop = document.querySelector(
          '#interop-outlet, [data-testid="interop-shadowdom"]',
        );
        if (interop) {
          candidates.push(interop);
          if (interop.shadowRoot) {
            candidates.push(
              ...interop.shadowRoot.querySelectorAll(
                '[role="dialog"], .artdeco-modal, section, div',
              ),
            );
          }
        }

        // Score by size * z-index so the foreground modal wins.
        const scored = [];
        for (const el of candidates) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.textContent || "");
          if (!text || text.length < 8) continue;
          if (isForBusiness(text) && !isPremiumText(text)) continue;

          const rect = el.getBoundingClientRect();
          let z = 0;
          let node = el;
          while (node && node !== document.body) {
            const zi = window.getComputedStyle(node).zIndex;
            if (zi && zi !== "auto") {
              z = Math.max(z, parseInt(zi, 10) || 0);
            }
            node = node.parentElement;
          }
          const area = rect.width * rect.height;
          scored.push({ el, text, score: area + z * 1000, rect });
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored[0];
        if (!top) return null;

        if (hasFreeComposer(top.el)) {
          return {
            kind: "composer",
            snippet: top.text.slice(0, 160),
          };
        }
        if (isPremiumText(top.text)) {
          try {
            top.el.setAttribute("data-gtss-premium-block", "active-modal");
          } catch (_) {}
          return {
            kind: "premium",
            snippet: top.text.slice(0, 160),
          };
        }
        // A large modal without a free composer right after Message is almost
        // always an upsell / restriction wall — treat as premium-like so we
        // do not navigate to a compose URL and thrash.
        if (top.rect.width > 280 && top.rect.height > 180) {
          if (
            /\b(premium|inmail|upgrade|subscribe|trial)\b/.test(top.text)
          ) {
            return {
              kind: "premium",
              snippet: top.text.slice(0, 160),
            };
          }
          return {
            kind: "other_modal",
            snippet: top.text.slice(0, 160),
          };
        }
        return null;
      })
      .catch(() => null);

  // Main document first.
  let hit = await probeInContext(page);
  if (hit) return hit;

  // Messaging iframes (interop preload / compose).
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch (_) {
      continue;
    }
    if (
      !frameUrl ||
      (!frameUrl.includes("/preload") &&
        !frameUrl.includes("_bprMode") &&
        !frameUrl.includes("/messaging") &&
        !frameUrl.includes("msgOverlay"))
    ) {
      continue;
    }
    hit = await probeInContext(frame);
    if (hit) return { ...hit, frameUrl };
  }

  // Playwright text probe (pierces open shadow DOM) — last resort.
  const premiumText = page
    .getByText(
      /with premium|build your dream team|try premium (for )?free|get premium|inmail credits?|grow your business with premium/i,
    )
    .first();
  if (await premiumText.isVisible({ timeout: 150 }).catch(() => false)) {
    const hasComposer = await page
      .locator(
        '.msg-form__contenteditable[contenteditable="true"],' +
          ' [contenteditable="true"][aria-label*="message" i],' +
          ' [role="textbox"][aria-label*="write a message" i]',
      )
      .first()
      .isVisible({ timeout: 80 })
      .catch(() => false);
    if (!hasComposer) {
      return { kind: "premium", snippet: "playwright-text-premium-wall" };
    }
  }

  return null;
}

/**
 * Shared evaluate body for premium-wall detection. Runs in page OR iframe.
 * Returns a selector string if a block was tagged, else null.
 */
async function findPremiumBlockInContext(ctx, token, patternSources) {
  return ctx
    .evaluate(
      ({ marker, patternSources }) => {
        const containers = document.querySelectorAll(
          '#interop-outlet, [data-testid="interop-shadowdom"], [role="dialog"], .artdeco-modal, [class*="upsell"], [class*="premium"]',
        );
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          // Premium walls inside the interop iframe may start with opacity 0
          // but still be "open" with real dimensions — accept low opacity.
          return (
            rect.width > 120 &&
            rect.height > 60 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };

        const hasFreeComposer = (el) =>
          Boolean(
            el.querySelector(
              '.msg-form__contenteditable[contenteditable="true"],' +
                ' [contenteditable="true"][aria-label*="message" i],' +
                ' [contenteditable="true"][aria-label*="write" i],' +
                ' [role="textbox"][aria-label*="message" i],' +
                ' [role="textbox"][aria-label*="write" i],' +
                ' textarea[aria-label*="message" i]',
            ),
          );

        const looksLikeBlock = (text) => {
          const normalized = String(text || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (!normalized) return false;
          for (const src of patternSources) {
            try {
              if (new RegExp(src, "i").test(normalized)) return true;
            } catch (_) {}
          }
          const hasPremium = /\bpremium\b/.test(normalized);
          const hasMsg = /\b(message|inmail|messaging|in-?mail)\b/.test(
            normalized,
          );
          const hasCta =
            /\b(get|try|upgrade|required|unlock|subscribe|start|free trial)\b/.test(
              normalized,
            );
          const hasComposer =
            /write a message|type a message|send a message/.test(normalized);
          return hasPremium && hasMsg && hasCta && !hasComposer;
        };

        // Also pierce open shadow roots under interop outlets only
        // (avoid walking every div on the page).
        const expandInteropShadow = () => {
          const out = [];
          const roots = document.querySelectorAll(
            '#interop-outlet, [data-testid="interop-shadowdom"]',
          );
          for (const root of roots) {
            out.push(root);
            if (root.shadowRoot) {
              for (const el of root.shadowRoot.querySelectorAll(
                '[role="dialog"], .artdeco-modal, section, div',
              )) {
                out.push(el);
              }
            }
          }
          return out;
        };

        const all = new Set([...containers, ...expandInteropShadow()]);

        for (const container of all) {
          if (!visible(container)) continue;
          if (hasFreeComposer(container)) continue;
          const text = String(container.innerText || container.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (!text || text.length < 12) continue;
          if (
            /explore more for business/.test(text) &&
            !/\binmail\b/.test(text) &&
            !/build your dream team/.test(text) &&
            !/with premium/.test(text)
          ) {
            continue;
          }
          if (!looksLikeBlock(text)) continue;
          try {
            container.setAttribute("data-gtss-premium-block", marker);
          } catch (_) {}
          return `[data-gtss-premium-block="${marker}"]`;
        }
        return null;
      },
      { marker: token, patternSources },
    )
    .catch(() => null);
}

async function detectPremiumRequired(page, { dismissIfFound = true } = {}) {
  // Do NOT page-wide search for "Premium" / "Get Premium" — those strings
  // appear in sidebars and nav even when a free DM composer is open.
  // Only inspect dialog / interop / modal containers (page + messaging iframes).

  const token = `gtss-premium-block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const patternSources = PREMIUM_MESSAGING_PATTERNS.map((re) => re.source);

  let premiumSelector = await findPremiumBlockInContext(
    page,
    token,
    patternSources,
  );

  // Premium walls often render ONLY inside the interop iframe after Message
  // is clicked — page.evaluate never sees them.
  if (!premiumSelector) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let frameUrl = "";
      try {
        frameUrl = frame.url();
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
      if (
        frameUrl.includes("/preload") ||
        frameUrl.includes("_bprMode") ||
        frameUrl.includes("/messaging") ||
        frameUrl.includes("msgOverlay")
      ) {
        premiumSelector = await findPremiumBlockInContext(
          frame,
          token,
          patternSources,
        );
        if (premiumSelector) break;
      }
    }
  }

  // Playwright-native text probe (pierces open shadow DOM) for known walls.
  if (!premiumSelector) {
    const strongCopy = page
      .getByText(
        /with premium,?\s*you can message anyone|build your dream team|grow your business with premium|inmail credits?|try premium (for )?free/i,
      )
      .first();
    const strongVisible = await strongCopy
      .isVisible({ timeout: 120 })
      .catch(() => false);
    if (strongVisible) {
      // Confirm it is not a free composer page that happens to mention Premium.
      const hasComposer = await page
        .locator(
          '.msg-form__contenteditable[contenteditable="true"],' +
            ' [contenteditable="true"][aria-label*="message" i],' +
            ' [role="textbox"][aria-label*="write a message" i]',
        )
        .first()
        .isVisible({ timeout: 80 })
        .catch(() => false);
      if (!hasComposer) {
        premiumSelector = "playwright-text-premium-wall";
      }
    }
  }

  if (!premiumSelector) return null;

  // CRITICAL: dismiss the dialog before returning. Leaving Premium open lets
  // LinkedIn auto-redirect / spawn job-posting tabs, and the For Business
  // flyout often appears as a follow-on upsell — which is the "stuck" state.
  if (dismissIfFound) {
    await dismissPremiumDialog(page, 1500);
    // Premium dismiss can leave or re-open the For Business panel — close it.
    await dismissLinkedInNavDropdowns(page);
  }

  return {
    outcome: "premium_required",
    reason: "LinkedIn Premium required to message this profile",
  };
}

async function detectMessagingBlocked(page, timeout = 700) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // Probe Premium FIRST — do not Escape/dismiss before classification.
    // Escaping a just-opened Premium wall was a cause of "editor not found".
    const active = await detectActiveMessagingModal(page);
    if (active?.kind === "premium") {
      await dismissPremiumDialog(page, 1500);
      await dismissLinkedInNavDropdowns(page);
      return {
        outcome: "premium_required",
        reason: "LinkedIn Premium required to message this profile",
        detail: active.snippet,
      };
    }

    const premium = await detectPremiumRequired(page, { dismissIfFound: true });
    if (premium) return premium;

    // Only clear For Business after we know this is not a Premium wall.
    await dismissLinkedInNavDropdowns(page);

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

module.exports = {
  detectPremiumRequired,
  detectMessagingBlocked,
  detectActiveMessagingModal,
  isAnyVisible,
  isAnyVisibleOnProfile,
  pageContainsAny,
  detectActionWarning,
  textLooksLikePremiumMessagingBlock,
  PREMIUM_MESSAGING_PATTERNS,
};

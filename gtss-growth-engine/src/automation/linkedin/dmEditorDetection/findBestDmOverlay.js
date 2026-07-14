/**
 * findBestDmOverlay — modal-aware overlay selection.
 *
 * Extracted from the original dmEditorDetection.js (split for maintainability).
 *
 * CRITICAL FIX (wrong-recipient bug): the previous implementation scored
 * overlays purely by "has editor + text match + size". When LinkedIn showed
 * the alternate compose modal (Title/Subject input + Message input) WHILE a
 * background conversation bubble was already open, both overlays scored
 * similarly and the tie-breaker (DOM order / rect.top) could pick the
 * background bubble's editor — causing messages to be sent to the wrong
 * recipient.
 *
 * The new scoring uses unambiguous signals to identify the *active* modal:
 *
 *   +5000  aria-modal="true"          (W3C standard marker for a blocking modal)
 *   +4000  has a Subject/Title input  (alternate compose modal marker —
 *                                     the bug scenario modal has BOTH inputs)
 *   +1500  "new message" heading text (compose modal marker)
 *   +zIdx  higher z-index             (topmost stacking context wins)
 *   +idx*30 later DOM position        (recently mounted overlays win)
 *   -∞     aria-expanded="false"      (minimized bubble — never picked)
 *   -∞     height < 100               (minimized bubble — never picked)
 *
 * FAIL-SAFE: if the top two overlays score within 500 points of each other,
 * we cannot confidently identify the active one and return `{ ambiguous: true }`
 * so the caller can abort instead of risking a wrong-modal send.
 */

const { humanDelay } = require("../../browserBase");
const logger = require("../../../utils/logger");

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
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < (window.innerHeight || 900) &&
              rect.left < (window.innerWidth || 1400) &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity || 1) > 0
            );
          };

          // Editor presence — an overlay is only a candidate if it actually
          // contains a text editor. This rules out header-only minimized
          // bubbles that happen to meet the width/height threshold.
          const hasEditor = (el) =>
            Boolean(
              el.querySelector(
                '.msg-form__contenteditable[contenteditable="true"], ' +
                  '.msg-form [contenteditable="true"], ' +
                  "textarea, [role=\"textbox\"]",
              ),
            );

          // Subject / Title input detection — the alternate compose modal
          // (the bug scenario) is the only LinkedIn messaging surface that
          // has a Title/Subject field alongside the message body.
          const hasSubjectInput = (el) =>
            Boolean(
              el.querySelector(
                'input[aria-label*="subject" i], ' +
                  'input[placeholder*="subject" i], ' +
                  'input[aria-label*="title" i], ' +
                  'input[placeholder*="title" i], ' +
                  'input[name*="subject" i], ' +
                  'input[name*="title" i]',
              ),
            );

          // Minimized bubble detection — LinkedIn collapses conversation
          // bubbles to a header-only strip when minimized. We must NEVER
          // pick these because their editor exists in the DOM but is
          // invisible/hidden and typing would silently land in the wrong place.
          const isMinimized = (el) => {
            const expanded = el.getAttribute("aria-expanded");
            if (expanded === "false") return true;
            const rect = el.getBoundingClientRect();
            // Minimized bubbles are typically < 100px tall (just the header).
            if (rect.height < 100) return true;
            // Some LinkedIn bubbles use a "minimized" class instead.
            if (/\b(minimized|collapsed)\b/i.test(el.className || "")) return true;
            return false;
          };

          // Walk up to body to find the first ancestor with a non-auto z-index.
          const getZIndex = (el) => {
            let node = el;
            while (node && node !== document.body) {
              const z = window.getComputedStyle(node).zIndex;
              if (z && z !== "auto") return parseInt(z, 10) || 0;
              node = node.parentElement;
            }
            return 0;
          };

          // Try to extract the recipient name from the modal header. Used
          // both for scoring (chat bubbles have a recipient header; compose
          // modals typically don't) and for downstream recipient verification.
          const getRecipientName = (el) => {
            const headerSelectors = [
              ".msg-overlay-bubble-header__name",
              ".msg-overlay-conversation-bubble__name",
              ".msg-convo-wrapper__name",
              ".msg-form__recipient-name",
              '[data-control-name="overlay.header"] [data-control-name="overlay.participant"]',
              ".msg-overlay-bubble-header a[href*=\"/in/\"]",
              ".msg-convo-wrapper a[href*=\"/in/\"]",
              ".msg-overlay-bubble-header a",
            ];
            for (const sel of headerSelectors) {
              const node = el.querySelector(sel);
              if (node) {
                const text = (node.textContent || node.getAttribute("title") || "")
                  .trim();
                if (text && text.length > 0 && text.length < 100) {
                  return text;
                }
              }
            }
            return null;
          };

          const overlaySelectors =
            ".msg-overlay-conversation-bubble, .msg-convo-wrapper, [role=\"dialog\"], .artdeco-modal--type-is-messaging";

          const overlays = [...document.querySelectorAll(overlaySelectors)]
            .filter(visible)
            .filter((el) => !isMinimized(el))
            .map((el, idx) => {
              if (!hasEditor(el)) return null;

              const rect = el.getBoundingClientRect();
              const text = normalize(el.textContent);
              const subjectPresent = hasSubjectInput(el);
              const zIndex = getZIndex(el);
              const ariaModal = el.getAttribute("aria-modal") === "true";
              const recipientName = getRecipientName(el);

              let score = 0;

              // === STRONG IDENTITY SIGNALS ===
              if (ariaModal) score += 5000;
              if (subjectPresent) score += 4000;
              if (/new message|compose|write a message/.test(text)) score += 1500;

              // === STACKING / RECENCY SIGNALS ===
              score += Math.min(2000, zIndex * 10);
              score += idx * 30; // later in DOM = more recently mounted

              // === SIZE / VISIBILITY SIGNALS ===
              if (rect.height >= 260) score += 180;
              score += Math.min(220, (rect.width * rect.height) / 1800);

              // Chat-bubble recipient header — minor bonus so an open chat
              // bubble still scores higher than a stale hidden one, but the
              // compose-modal bonuses above always beat it.
              if (recipientName && !subjectPresent) score += 200;

              return {
                el,
                score,
                text: text.slice(0, 80),
                zIndex,
                ariaModal,
                subjectPresent,
                recipientName,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);

          if (overlays.length === 0) return null;

          // FAIL-SAFE: if the top two overlays score within 500 points,
          // we cannot confidently identify the active one. Return ambiguous
          // so the caller aborts instead of risking a wrong-modal send.
          if (overlays.length >= 2) {
            const gap = overlays[0].score - overlays[1].score;
            if (gap < 500) {
              return {
                ambiguous: true,
                topScore: Math.round(overlays[0].score),
                secondScore: Math.round(overlays[1].score),
                count: overlays.length,
                topLabel: overlays[0].text,
                secondLabel: overlays[1].text,
              };
            }
          }

          const best = overlays[0];
          best.el.setAttribute("data-gtss-dm-overlay", token);
          return {
            selector: `[data-gtss-dm-overlay="${token}"]`,
            score: Math.round(best.score),
            label: best.text,
            hasSubject: best.subjectPresent,
            recipientName: best.recipientName,
            isModal: best.ariaModal,
          };
        },
        { token },
      )
      .catch(() => null);

    // If scoring could not confidently identify the active modal, return the
    // ambiguous flag immediately — do NOT retry, do NOT pick the first one.
    if (result?.ambiguous) {
      return { ambiguous: true, detail: result };
    }

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

    await humanDelay(80, 130);
  }

  return null;
}

module.exports = { findBestDmOverlay };

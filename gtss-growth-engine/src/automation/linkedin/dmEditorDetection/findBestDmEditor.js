/**
 * findBestDmEditor — locate the best LinkedIn DM editor element on a page.
 *
 * Extracted from the original dmEditorDetection.js (split for maintainability).
 *
 * Critical fix: editor selection is ALWAYS scoped to the active modal first;
 * page-root scans are only used as a fallback AND only when exactly one
 * editor is visible (fail-safe against wrong-recipient sends).
 *
 * This function calls findBestDmOverlay (from ./findBestDmOverlay) to identify
 * the active modal first, then searches for editors ONLY inside that modal.
 */

const { humanDelay } = require("../../browserBase");
const logger = require("../../../utils/logger");
const { findBestDmOverlay } = require("./findBestDmOverlay");

async function findBestDmEditor(page, timeout = 2500) {
  const token = `gtss-dm-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  // Inner helper: search for an editor INSIDE a given overlay element only.
  // This is the heart of the bug fix — never query the page root for editors
  // when a known overlay exists.
  const findEditorInsideOverlay = async (overlayLocator) => {
    return overlayLocator
      .evaluate(
        (overlay, token) => {
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
            for (const el of overlay.querySelectorAll(selector)) {
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
              if (rect.height >= 80) score += 420;
              if (rect.height >= 140) score += 260;
              score += Math.min(260, (rect.width * rect.height) / 900);
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
        token,
      )
      .catch(() => null);
  };

  while (Date.now() < deadline) {
    // === STEP 1: Find the active overlay FIRST ===
    // Critical bug fix: scope editor selection to the active modal. Never
    // scan the page root for editors when a known overlay exists — doing so
    // would risk picking a background conversation bubble's editor and
    // sending the message to the wrong recipient.
    const remainingForOverlay = Math.min(1200, Math.max(200, deadline - Date.now()));
    const overlayMatch = await findBestDmOverlay(page, remainingForOverlay);

    if (overlayMatch?.ambiguous) {
      // Two equally-prominent modals — cannot safely pick. Fail safe.
      logger.warn(
        "LinkedIn DM editor selection aborted: ambiguous messaging modals detected. " +
          "Multiple overlays scored too similarly to confidently identify the active one. " +
          "Aborting to prevent wrong-recipient send.",
        { detail: overlayMatch.detail },
      );
      return null;
    }

    if (overlayMatch?.locator) {
      // === STEP 2: Search for editors ONLY inside the chosen overlay ===
      const editorResult = await findEditorInsideOverlay(overlayMatch.locator);

      if (editorResult?.selector) {
        const locator = page.locator(editorResult.selector).first();
        if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
          return {
            locator,
            selector: `best-dm-editor:${editorResult.selector}`,
            detail: { ...editorResult, overlay: overlayMatch.detail },
            overlay: overlayMatch,
          };
        }
      }
    }

    // === FALLBACK: page-root scan, but ONLY if exactly one visible editor exists ===
    // This preserves backward compat with LinkedIn UIs that don't wrap the
    // composer in any of our recognized overlay containers (.msg-overlay-
    // conversation-bubble, [role="dialog"], etc.). In that case the editor
    // exists at the page root and there should only be ONE — if there are
    // 2+, we cannot safely disambiguate and must fail safe.
    const fallbackResult = await page
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
            '[role="textbox"][aria-label*="message" i]',
            '[role="textbox"][aria-label*="write" i]',
            '[contenteditable="true"]',
            '[role="textbox"]',
            "textarea",
          ];
          const seen = new Set();
          const editors = [];

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

              const text = [
                el.getAttribute("aria-label"),
                el.getAttribute("placeholder"),
                el.getAttribute("data-placeholder"),
                el.getAttribute("name"),
                el.getAttribute("id"),
                el.className,
                el.textContent,
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

              // Reject subject/recipient-like fields.
              if (
                rejectPattern.test(text) &&
                !messagePattern.test(text)
              )
                continue;

              editors.push({ el, text });
            }
          }

          // FAIL-SAFE: if multiple visible editors exist at page root
          // WITHOUT a recognizable overlay wrapper, we cannot confidently
          // pick the right one. Return ambiguous so the caller aborts.
          if (editors.length > 1) {
            return { ambiguous: true, count: editors.length };
          }
          if (editors.length === 0) return null;

          const best = editors[0];
          best.el.setAttribute("data-gtss-dm-editor", token);
          return {
            selector: `[data-gtss-dm-editor="${token}"]`,
            score: 1,
            label: best.text.slice(0, 120),
          };
        },
        { token },
      )
      .catch(() => null);

    if (fallbackResult?.ambiguous) {
      logger.warn(
        "LinkedIn DM editor selection aborted: multiple page-root editors detected " +
          "without a recognizable overlay wrapper. Cannot safely identify the active modal. " +
          "Aborting to prevent wrong-recipient send.",
        { count: fallbackResult.count },
      );
      return null;
    }

    if (fallbackResult?.selector) {
      const locator = page.locator(fallbackResult.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `best-dm-editor-legacy:${fallbackResult.selector}`,
          detail: fallbackResult,
        };
      }
    }

    await humanDelay(80, 130);
  }

  return null;
}

module.exports = { findBestDmEditor };

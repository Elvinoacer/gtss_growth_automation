/**
 * Instagram Composer Action Helpers
 * Selector builders + DOM/playwright hybrid search for the labelled action
 * buttons (Next, Share, etc.) inside Instagram's create-post composer.
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { IG_SELECTORS } = require("./constants");

function cssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function instagramComposerActionSelectors(label) {
  const safeLabel = cssString(label);
  return [
    `div[role="dialog"] button[aria-label="${safeLabel}"]`,
    `div[role="dialog"] div[role="button"][aria-label="${safeLabel}"]`,
    `div[role="dialog"] [tabindex][aria-label="${safeLabel}"]`,
    `div[role="dialog"] button:has-text("${safeLabel}")`,
    `div[role="dialog"] div[role="button"]:has-text("${safeLabel}")`,
    `div[role="dialog"] span:text-is("${safeLabel}")`,
    `button[aria-label="${safeLabel}"]`,
    `div[role="button"][aria-label="${safeLabel}"]`,
    `button:has-text("${safeLabel}")`,
    `div[role="button"]:has-text("${safeLabel}")`,
  ];
}

async function findVisibleLocator(page, selectors, timeout = 800) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout }).catch(() => false);
    if (visible) return locator;
  }
  return null;
}

async function findInstagramComposerActionViaDom(page, label, click = false) {
  if (!page || typeof page.evaluate !== "function") return false;

  return page
    .evaluate(
      ({ actionLabel, shouldClick }) => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") !== 0 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const clickableAncestor = (el) => {
          let node = el;
          while (node && node !== document.body) {
            if (
              node.matches?.(
                'button, a, [role="button"], [role="link"], [tabindex]',
              )
            ) {
              return node;
            }
            node = node.parentElement;
          }
          return null;
        };

        const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')]
          .filter(isVisible)
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return bRect.width * bRect.height - aRect.width * aRect.height;
          });
        const root = visibleDialogs[0] || document.body;
        const rootRect = root.getBoundingClientRect();
        const topBarLimit = rootRect.top + Math.min(100, rootRect.height);

        const candidates = [
          ...root.querySelectorAll(
            'button, a, [role="button"], [role="link"], [tabindex], span, div',
          ),
        ]
          .filter(isVisible)
          .map((el) => {
            const target = clickableAncestor(el) || el;
            const rect = target.getBoundingClientRect();
            const text = normalize(el.innerText || el.textContent);
            const aria = normalize(el.getAttribute("aria-label"));
            return { el, target, rect, text, aria };
          })
          .filter(({ target, text, aria, rect }) => {
            if (!isVisible(target)) return false;
            if (target.getAttribute("aria-disabled") === "true") return false;
            if (target.disabled) return false;
            if (text !== actionLabel && aria !== actionLabel) return false;
            if (actionLabel === "Next" || actionLabel === "Share") {
              return rect.top <= topBarLimit;
            }
            return true;
          })
          .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);

        const match = candidates[0];
        if (!match) return false;
        if (shouldClick) {
          match.target.click();
        }
        return true;
      },
      { actionLabel: label, shouldClick: click },
    )
    .catch(() => false);
}

async function waitForInstagramComposerAction(page, label, timeout = 30000) {
  const selectors = instagramComposerActionSelectors(label);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, selectors, 500);
    if (locator) return locator;

    const foundViaDom = await findInstagramComposerActionViaDom(
      page,
      label,
      false,
    );
    if (foundViaDom) return null;

    await humanDelay(250, 500);
  }

  throw new Error(`Could not find Instagram composer "${label}" control.`);
}

async function clickInstagramComposerAction(page, label, timeout = 30000) {
  const selectors = instagramComposerActionSelectors(label);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, selectors, 500);
    if (locator) {
      await locator.click().catch(async () => {
        await locator.click({ force: true });
      });
      return true;
    }

    const clickedViaDom = await findInstagramComposerActionViaDom(
      page,
      label,
      true,
    );
    if (clickedViaDom) return true;

    await humanDelay(250, 500);
  }

  throw new Error(`Could not click Instagram composer "${label}" control.`);
}

async function findInstagramCaptionInput(page, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, IG_SELECTORS.captionBox, 500);
    if (locator) return locator;
    await humanDelay(250, 500);
  }

  return null;
}

module.exports = {
  cssString,
  instagramComposerActionSelectors,
  findVisibleLocator,
  findInstagramComposerActionViaDom,
  waitForInstagramComposerAction,
  clickInstagramComposerAction,
  findInstagramCaptionInput,
};

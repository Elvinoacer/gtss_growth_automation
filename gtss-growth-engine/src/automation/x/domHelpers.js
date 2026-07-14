/**
 * x/domHelpers.js
 *
 * Low-level Playwright DOM helpers used by every X automation action
 * (follow, DM, like). These wrap the canonical "find the first matching
 * element that's actually visible" pattern plus a handful of
 * composer-text verification helpers needed by the DM action.
 *
 * Exports:
 *   - firstVisible(page, selectors, timeout?)           — first visible
 *      element matching any selector (returns { locator, selector } or null)
 *   - firstVisibleIn(scope, selectors, timeout?)        — same, but
 *      scoped to a Playwright Locator (used internally + by
 *      firstVisibleOnProfile)
 *   - getProfileHeader(page)                            — locate the
 *      profile-page header wrapper (used to scope button lookups)
 *   - firstVisibleOnProfile(page, selectors, timeout?)  — first visible
 *      element matching any selector, scoped to the profile header
 *      (falls back to whole-page search if no header found)
 *   - pageContainsAny(page, phrases)                    — case-insensitive
 *      body-text search; returns the first matching phrase or null
 *   - detectActionWarning(page)                         — read any visible
 *      toast OR match the body text against a list of known rate-limit /
 *      try-again / DM-restriction phrases
 *   - checkAccountStatus(page, emit)                    — detect
 *      "account suspended" / "doesn't exist" empty states + URL-redirect
 *      suspension; emits an "error" event and returns a status object
 *   - messageSnippet(message)                           — normalize a DM
 *      body to a short snippet (used for thread-visibility verification)
 *   - normalizeEditableText(value)                      — collapse
 *      whitespace + replace NBSPs with regular spaces
 *   - getEditableText(locator)                          — read the text of
 *      a textbox/contenteditable (handles <textarea>, <input>, contenteditable)
 *   - verifyComposerContainsMessage(locator, message)   — true if the
 *      composer's current text contains the (normalized) message
 *   - ensureComposerContainsMessage(locator, message)   — verify, then
 *      if missing, attempt locator.fill(message) and re-verify
 *   - verifyDmSent(page, editorTarget, message)         — poll up to 8s
 *      for either the message snippet to appear in the thread OR the
 *      composer to clear; returns { verified, reason, unknown? }
 *   - typeLikeHuman(page, locatorOrSelector, text)      — click + type
 *      character-by-character with random 50-150ms inter-key delays
 *
 * Path notes: the original file used `require("./browserBase")` for
 * humanDelay / humanScroll — from this split file (one level deeper) that
 * becomes `require("../browserBase")`. (Both resolve to
 * src/automation/browserBase — the depth is preserved.) The original
 * `require("../utils/logger")` becomes `require("../../utils/logger")`
 * here.
 */

const { humanDelay, humanScroll } = require("../browserBase");
const { SELECTORS } = require("./selectors");

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

  return await firstVisibleIn(page, selectors, timeout);
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
  // Capture general toast message errors
  const toastMatch = await firstVisible(page, SELECTORS.toast, 1000);
  if (toastMatch) {
    const text = await toastMatch.locator.innerText().catch(() => "");
    if (text) return text.trim();
  }

  return pageContainsAny(page, [
    "rate limit exceeded",
    "unable to follow more",
    "unable to send",
    "something went wrong",
    "try again later",
    "restricted from direct messaging",
    "reach your limit",
    "you have reached the limit",
  ]);
}

async function checkAccountStatus(page, emit) {
  const emptyMatch = await firstVisible(page, SELECTORS.emptyState, 2000);
  if (emptyMatch) {
    const text = await emptyMatch.locator.innerText().catch(() => "");
    const lowerText = text.toLowerCase();

    if (lowerText.includes("suspended") || lowerText.includes("suspension")) {
      emit("error", "Target account is suspended.");
      return { suspended: true, reason: "Account suspended" };
    }

    if (
      lowerText.includes("doesn’t exist") ||
      lowerText.includes("doesn't exist")
    ) {
      emit("error", "Target account does not exist.");
      return { notFound: true, reason: "Account doesn't exist" };
    }
  }

  const isSuspendedUrl = page.url().toLowerCase().includes("suspended");
  if (isSuspendedUrl) {
    emit("error", "URL contains suspension warning.");
    return { suspended: true, reason: "Account suspended (URL redirect)" };
  }

  return { active: true };
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

async function getEditableText(locator) {
  return locator
    .evaluate((el) => {
      const tagName = String(el.tagName || "").toLowerCase();
      if (tagName === "textarea" || tagName === "input") {
        return String(el.value || "");
      }
      return String(el.innerText || el.textContent || "");
    })
    .catch(() => "");
}

async function verifyComposerContainsMessage(locator, message) {
  const expected = normalizeEditableText(message);
  if (!expected) return false;
  const actual = normalizeEditableText(await getEditableText(locator));
  return actual.includes(expected);
}

async function ensureComposerContainsMessage(locator, message) {
  if (await verifyComposerContainsMessage(locator, message)) return true;
  let fillSucceeded = false;
  if (typeof locator.fill === "function") {
    await locator
      .fill(String(message || ""))
      .then(() => {
        fillSucceeded = true;
      })
      .catch(() => {});
  } else {
    return true;
  }
  return (await verifyComposerContainsMessage(locator, message)) || fillSucceeded;
}

async function verifyDmSent(page, editorTarget, message) {
  const snippet = messageSnippet(message);
  const editorLocator =
    typeof editorTarget === "string"
      ? page.locator(editorTarget).first()
      : editorTarget;

  // Poll up to 8 seconds for the message to appear or the composer to clear
  const POLL_INTERVAL = 800;
  const MAX_POLLS = 10;

  for (let i = 0; i < MAX_POLLS; i++) {
    await humanDelay(POLL_INTERVAL, POLL_INTERVAL + 200);

    const visibleInThread = snippet
      ? await page
          .getByText(snippet, { exact: false })
          .last()
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      : false;

    if (visibleInThread) {
      return { verified: true, reason: "Message visible in thread" };
    }

    const editorText = await editorLocator
      .evaluate(
        (el) => {
          const tagName = String(el.tagName || "").toLowerCase();
          if (tagName === "textarea" || tagName === "input") {
            return String(el.value || "").trim();
          }
          return String(el.textContent || el.innerText || "").trim();
        },
        undefined,
        { timeout: 1000 },
      )
      .catch(() => "");

    if (!editorText) {
      return { verified: true, reason: "Composer cleared" };
    }

    // Check for visible warning before giving up
    const warning = await detectActionWarning(page);
    if (warning) {
      return { verified: false, reason: `X warning: ${warning}` };
    }
  }

  return {
    verified: false,
    unknown: true,
    reason:
      "Send verification ambiguous - message not visible and composer did not clear",
  };
}

/**
 * Type a string character by character with human-like delays
 */
async function typeLikeHuman(page, locatorOrSelector, text) {
  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector).first()
      : locatorOrSelector;

  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await humanDelay(300, 600);

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    const delay = Math.floor(Math.random() * 100) + 50;
    await humanDelay(delay, delay + 20);
  }
}

module.exports = {
  firstVisible,
  firstVisibleIn,
  getProfileHeader,
  firstVisibleOnProfile,
  pageContainsAny,
  detectActionWarning,
  checkAccountStatus,
  messageSnippet,
  normalizeEditableText,
  getEditableText,
  verifyComposerContainsMessage,
  ensureComposerContainsMessage,
  verifyDmSent,
  typeLikeHuman,
};

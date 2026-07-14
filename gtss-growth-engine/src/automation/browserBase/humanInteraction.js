/**
 * Browser Base — Human-Like Interaction Primitives
 * humanDelay, humanScroll, humanTypeText, humanMouseMove, detectCaptcha,
 * textContainsAny, getPageBodyText — primitives that simulate realistic
 * human input patterns (random waits, per-character typing, organic mouse
 * movement) and a couple of small text-scan helpers used by the session
 * classifiers.
 * Extracted from the original browserBase.js for maintainability.
 */

const logger = require("../../utils/logger");

/**
 * Wait for a random duration between min and max milliseconds to simulate human behavior.
 */
function humanDelay(min = 3000, max = 15000) {
  if (process.env.TEST_SPEEDUP === "true") {
    return Promise.resolve();
  }
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scroll the page randomly 1-3 times with human-like delays.
 *
 * Defensive against a closed page/browser: if the user (or a tab crash)
 * closes the page mid-scroll, Playwright throws "Target page, context or
 * browser has been closed". We swallow that specific error so the caller
 * can decide how to handle a missing page (e.g. the pipeline's abort
 * path) instead of crashing the whole run with an uncaught exception.
 */
async function humanScroll(page) {
  const scrolls = Math.floor(Math.random() * 3) + 1; // 1 to 3 scrolls
  for (let i = 0; i < scrolls; i++) {
    // Scroll a random amount between 200 and 800 pixels
    const scrollAmount = Math.floor(Math.random() * 600) + 200;
    try {
      await page.mouse.wheel(0, scrollAmount);
    } catch (err) {
      // If the page/context/browser was closed mid-scroll, re-throw a
      // typed error the caller can match on. Otherwise propagate.
      const msg = String(err && err.message || err);
      if (/Target page, context or browser has been closed|Browser has been closed|Page closed/i.test(msg)) {
        const closedErr = new Error(`humanScroll: page closed mid-scroll (${msg})`);
        closedErr.code = "PAGE_CLOSED";
        throw closedErr;
      }
      throw err;
    }
    await humanDelay(1000, 3000);
  }
}

/**
 * Type a string character by character with human-like delays into a locator or selector.
 *
 * ─── Why per-character instead of locator.type(text, { delay }) ──────────
 * The previous optimisation (commit 4522045) replaced this per-character
 * loop with a single `target.type(text, { delay })` call, mirroring the
 * LinkedIn fast-typing path. That works for LinkedIn's contenteditable
 * (which is a ProseMirror-style editor that handles Playwright's bulk
 * type() correctly), but it REGRESSED Instagram posting because:
 *
 *   1. Instagram's caption box is a React-controlled contenteditable
 *      div. When Playwright's bulk type() dispatches a burst of
 *      keydown/keypress/keyup events, React's synthetic event system
 *      occasionally drops intermediate events (especially for long
 *      captions with newlines and emoji). The visible text looks fine,
 *      but React's internal state never updates, so when Instagram
 *      validates the form before Share, it sees an empty caption.
 *   2. The fallback path (commit 4522045) wrote `element.textContent =
 *      textValue` directly. This is even worse for React — React doesn't
 *      reconcile external DOM mutations on a controlled component, so
 *      the caption stays empty in React state even though the DOM shows
 *      the text. Instagram's Share button stays disabled, the post
 *      attempt fails, and the automation tab is closed by the finally
 *      block in publishPost() — exactly the "Instagram opens then closes
 *      immediately" symptom the user reported.
 *
 * Per-character `page.keyboard.type(char)` with a small human-like
 * delay dispatches each keystroke as a separate event tuple, giving
 * React time to reconcile after each character. This is slower but
 * RELIABLE across Instagram / X / Facebook / LinkedIn. The per-char
 * delay is capped to 30-70ms (down from the original 50-150ms) so
 * caption typing takes ~10-30s for a 2200-char IG caption — fast
 * enough not to bottleneck the pipeline.
 *
 * Signature unchanged — existing call sites do not need updates.
 */
async function humanTypeText(page, locatorOrSelector, text) {
  if (!text) return;
  const target =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector)
      : locatorOrSelector;

  // Click the target so it has focus before we type. We swallow click
  // errors here (instead of letting them propagate) so that a transient
  // "element is not visible" doesn't abort the whole post — the typing
  // fallbacks below will surface a clearer error if the element truly
  // can't be interacted with.
  await target.click({ timeout: 8000 }).catch(() => {});
  // Clear any existing text using keyboard select all if needed
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  // Per-character typing — see the long comment above for why this is
  // NOT `target.type(text, { delay })`. Each character is a separate
  // keyboard event so React-controlled editors (Instagram, X) reconcile
  // correctly. In TEST_SPEEDUP mode we skip the human delay.
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (process.env.TEST_SPEEDUP !== "true") {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 40) + 30),
      );
    }
  }

  // ── Best-effort verification: ensure the text actually made it into ──
  // ── the element. If the editor swallowed the typing (rare but happens ──
  // ── when React re-rendered mid-typing), fall back to direct DOM      ──
  // ── mutation + synthetic input event so the editor at least shows    ──
  // ── the text. This fallback uses `innerText` (NOT `textContent`) so  ──
  // ── visible line breaks are preserved, and dispatches an `input`     ──
  // ── InputEvent with `inputType: "insertText"` which React's          ──
  // ── synthetic event system DOES pick up.                             ──
  try {
    const current = await target.evaluate((node) => {
      if (typeof node.value === "string") return node.value;
      return node.innerText || node.textContent || "";
    }).catch(() => "");
    if (current === text) return;
    // If the typed text matches what's in the editor (allowing for
    // minor whitespace differences), we're done.
    const normalised = (s) => String(s || "").replace(/\s+/g, " ").trim();
    if (normalised(current) === normalised(text)) return;
  } catch (_) {
    // Verification failed — proceed to fallback.
  }

  // Fallback: direct DOM mutation. Used only when the per-character
  // typing didn't produce the expected text (e.g., React re-rendered
  // mid-typing and swallowed some keystrokes).
  try {
    await target.evaluate((node, value) => {
      const element = node;
      const textValue = String(value);

      element.focus();

      if (typeof element.value === "string") {
        // <textarea> / <input> — use the native setter so React's
        // onChange fires.
        const descriptor = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(element),
          "value",
        );
        if (descriptor && descriptor.set) {
          descriptor.set.call(element, textValue);
        } else {
          element.value = textValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      // contenteditable — set innerText (preserves line breaks) and
      // dispatch an InputEvent with insertText so React reconciles.
      // The previous fallback used `textContent`, which strips line
      // breaks AND doesn't trigger React's onChange.
      element.innerText = textValue;
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: textValue,
        }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, text);
  } catch (_) {
    // Last resort: ignore. The per-character typing already ran; if it
    // didn't take, the caller will see the empty caption and can decide
    // how to handle it (e.g., abort the post).
  }
}

/**
 * Simulates a natural human mouse hover/movement to an element.
 */
async function humanMouseMove(page, element) {
  const box = await element.boundingBox();
  if (!box) {
    logger.warn("humanMouseMove", "Element bounding box not found");
    return;
  }

  // 1. Move to a random offset near the element first
  const offsetX = box.x + box.width / 2 + (Math.random() * 60 - 30);
  const offsetY = box.y + box.height / 2 + (Math.random() * 60 - 30);
  await page.mouse.move(Math.max(0, offsetX), Math.max(0, offsetY));

  // 2. Delay between steps (100ms - 400ms)
  await humanDelay(100, 400);

  // 3. Move to the element center
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
}

/**
 * Check if the page contains signs of a CAPTCHA or security challenge.
 */
async function detectCaptcha(page) {
  try {
    const content = await page.innerText("body").catch(() => "");
    const contentLower = content.toLowerCase();

    const triggers = [
      "captcha",
      "verify you're human",
      "verify you are human",
      "unusual activity",
      "security check",
      "prove you are human",
    ];

    return triggers.some((trigger) => contentLower.includes(trigger));
  } catch (error) {
    logger.warn("Error detecting CAPTCHA", { error: error.message });
    return false; // Fail safe
  }
}

function textContainsAny(text, phrases) {
  const normalized = String(text || "").toLowerCase();
  return (
    phrases.find((phrase) => normalized.includes(phrase.toLowerCase())) || null
  );
}

async function getPageBodyText(page) {
  return page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
}

module.exports = {
  humanDelay,
  humanScroll,
  humanTypeText,
  humanMouseMove,
  detectCaptcha,
  textContainsAny,
  getPageBodyText,
};

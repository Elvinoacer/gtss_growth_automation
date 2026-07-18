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
 * ─── Newlines must NOT be typed as Enter ────────────────────────────────
 * Chat composers (Facebook Messenger, Instagram DMs, many others) bind
 * bare Enter to "Send message". `page.keyboard.type("\n")` synthesizes
 * Enter, so a multi-line DM was sending after the first line and leaving
 * the rest of the message unsent or split across accidental sends.
 * Shift+Enter inserts a line break without submitting — same approach
 * LinkedIn's typing helpers already use. Post-caption editors also treat
 * Shift+Enter as a newline, so this is safe for captions too.
 *
 * Signature unchanged — existing call sites do not need updates.
 */

/** Collapse whitespace / invisible chars for editor content comparisons. */
function normalizeEditorCompareText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Alphanumeric-only fingerprint (ignores emoji encoding differences). */
function editorTextFingerprint(s) {
  return normalizeEditorCompareText(s)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

/**
 * True when the editor already holds the intended copy (once).
 * Facebook Lexical composers often reformat emoji/newlines so a strict
 * equality check fails even when the caption is correct — and the old
 * fallback then re-inserted the same body, producing a doubled post.
 */
function editorLooksComplete(current, expected) {
  const e = normalizeEditorCompareText(expected);
  if (!e) return true;
  const c = normalizeEditorCompareText(current);
  if (!c) return false;
  if (c === e) return true;
  // Expected present once (allow short trailing junk / "See more" chrome).
  if (c.includes(e) && c.length <= Math.ceil(e.length * 1.35)) return true;

  const fe = editorTextFingerprint(expected);
  const fc = editorTextFingerprint(current);
  if (!fe) return true;
  if (fc === fe) return true;
  // High-coverage fingerprint match (emoji / ZWJ differences).
  if (fc.includes(fe) && fc.length <= Math.ceil(fe.length * 1.35)) return true;
  if (fe.length >= 24 && fc.startsWith(fe.slice(0, Math.floor(fe.length * 0.9)))) {
    return true;
  }
  return false;
}

/** True when the body appears concatenated twice (the FB double-post bug). */
function editorLooksDoubled(current, expected) {
  const e = normalizeEditorCompareText(expected);
  const c = normalizeEditorCompareText(current);
  if (!e || e.length < 20) return false;
  if (c.length < e.length * 1.6) return false;
  const compact = (s) => s.replace(/\s+/g, "");
  const cc = compact(c);
  const ee = compact(e);
  if (cc.includes(ee + ee)) return true;
  // Soft check: fingerprint appears twice back-to-back.
  const fe = editorTextFingerprint(expected);
  const fc = editorTextFingerprint(current);
  if (fe.length >= 16 && fc.includes(fe + fe)) return true;
  return false;
}

async function readEditorText(target) {
  return target
    .evaluate((node) => {
      if (typeof node.value === "string") return node.value;
      return node.innerText || node.textContent || "";
    })
    .catch(() => "");
}

async function clearEditorContents(page, target) {
  await target.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  // contenteditable sometimes needs Meta on macOS — try both is cheap.
  if (process.platform === "darwin") {
    await page.keyboard.press("Meta+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
  }
}

/**
 * Replace editor contents with a single bulk insert (no double-write).
 * Used when per-char typing is incomplete OR when the body was doubled.
 */
async function replaceEditorWithInsertText(page, target, value) {
  await clearEditorContents(page, target);
  // Playwright insertText fires beforeinput/input the way Lexical/Draft
  // expect, without the "set innerText THEN insertText" double that used
  // to concatenate the caption twice on Facebook.
  if (typeof page.keyboard.insertText === "function") {
    await page.keyboard.insertText(value).catch(async () => {
      // Older Playwright / odd targets — fall back to type with newlines
      // as Shift+Enter.
      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\n") {
          await page.keyboard.press("Shift+Enter").catch(() => {});
        } else {
          await page.keyboard.type(ch);
        }
      }
    });
  } else {
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === "\n") {
        await page.keyboard.press("Shift+Enter").catch(() => {});
      } else {
        await page.keyboard.type(ch);
      }
    }
  }
}

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
  await clearEditorContents(page, target);

  // Normalize CRLF/CR so each logical newline is handled once.
  const value = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Per-character typing — see the long comment above for why this is
  // NOT `target.type(text, { delay })`. Each character is a separate
  // keyboard event so React-controlled editors (Instagram, X) reconcile
  // correctly. Newlines use Shift+Enter so Messenger/IG DM composers do
  // not send mid-message. In TEST_SPEEDUP mode we skip the human delay.
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\n") {
      await page.keyboard.press("Shift+Enter").catch(() => {});
    } else {
      await page.keyboard.type(ch);
    }
    if (process.env.TEST_SPEEDUP !== "true") {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 40) + 30),
      );
    }
  }

  // ── Verification ───────────────────────────────────────────────────────
  // Accept "good enough" matches so we do NOT re-insert into Facebook's
  // Lexical composer (set-innerText + insertText was concatenating the
  // caption twice → "bodybody" posts).
  let current = await readEditorText(target);
  if (editorLooksComplete(current, value) && !editorLooksDoubled(current, value)) {
    return;
  }

  // Doubled or incomplete → clear once and bulk-insert a single copy.
  try {
    await replaceEditorWithInsertText(page, target, value);
    current = await readEditorText(target);
    if (editorLooksComplete(current, value) && !editorLooksDoubled(current, value)) {
      return;
    }
    // Still doubled? Clear + insert one more time only.
    if (editorLooksDoubled(current, value)) {
      await replaceEditorWithInsertText(page, target, value);
    }
  } catch (_) {
    // Last resort for plain inputs only — never combine innerText + insertText
    // on contenteditable (that path caused Facebook caption duplication).
    try {
      await target.evaluate((node, textValue) => {
        const element = node;
        if (typeof element.value !== "string") return;
        element.focus();
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
      }, value);
    } catch (__) {
      // Caller may still see empty/wrong caption and can abort.
    }
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

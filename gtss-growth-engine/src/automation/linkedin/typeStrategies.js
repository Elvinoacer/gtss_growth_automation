/**
 * LinkedIn DM Editor — Typing Strategies
 * High-level text-entry strategies for LinkedIn's DM composer:
 *   - typeFast: throughput-optimised single-shot insertText with fallbacks
 *   - typeInChunks: chunked insertText for long-form messages
 *   - typeLikeHuman: human-like per-character typing with multi-strategy
 *     fallbacks (atomic insertText → chunked → per-character → clipboard → DOM)
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const {
  ensureSelectionInEditor,
  getEditableText,
} = require("./editorText");
const {
  pasteTextViaClipboard,
  setEditorTextWithDomEvents,
} = require("./editorPaste");
const { forceClearDmDraft } = require("./editorVerification");
const { activateDmEditor } = require("./typing");

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
 * Chunked typing helper for long-form text in LinkedIn's contenteditable
 * editors.
 *
 * Splits the text into ~chunkSize-char chunks at whitespace boundaries and
 * calls page.keyboard.insertText(chunk) per chunk, with a small settle
 * delay between chunks. Between chunks we re-locate the editor (in case
 * React re-rendered it) and verify the cumulative text matches the prefix
 * we've typed so far. If a chunk fails to land, we abort and let the
 * caller fall back to per-character typing or clipboard paste.
 *
 * This addresses the long-text truncation bug where a single atomic
 * insertText of a 3000+ char message would silently fail past LinkedIn's
 * editor buffer or React's beforeinput handler.
 *
 * @returns {Promise<boolean>} true if all chunks landed and the final
 *   editor text contains the full value.
 */
async function typeInChunks(page, locatorOrSelector, text, opts = {}) {
  const chunkSize = Number(opts.chunkSize) > 0 ? Number(opts.chunkSize) : 500;
  const settleMs = Number(opts.settleMs) >= 0 ? Number(opts.settleMs) : 120;

  const locator =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector)
      : locatorOrSelector;

  const value = String(text || "");
  if (!value) return false;

  // Split into chunks at whitespace boundaries, never exceeding chunkSize.
  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    let end = Math.min(cursor + chunkSize, value.length);
    // If we're not at the end, advance to the next whitespace boundary so
    // we don't split a word in half — React's editor can occasionally drop
    // a chunk that ends mid-word.
    if (end < value.length) {
      // Look for the next newline (preferred) or any whitespace within
      // the last 30% of the chunk window.
      const searchStart = end - Math.floor(chunkSize * 0.3);
      const nlIdx = value.indexOf("\n", searchStart);
      if (nlIdx > -1 && nlIdx <= end + Math.floor(chunkSize * 0.3)) {
        end = nlIdx + 1;
      } else {
        const wsMatch = value.slice(searchStart).match(/\s/);
        if (wsMatch && wsMatch.index !== undefined) {
          end = searchStart + wsMatch.index + 1;
        }
      }
    }
    chunks.push(value.slice(cursor, end));
    cursor = end;
  }

  const normalizeWS = (s) => String(s).replace(/\s+/g, " ").trim();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Re-locate the editor between chunks in case React re-rendered it.
    let currentLocator = locator;
    try {
      const stillVisible = await locator.isVisible({ timeout: 1500 }).catch(() => false);
      if (!stillVisible) {
        // Try to recover by re-activating the editor.
        await activateDmEditor(page, locator).catch(() => {});
      }
    } catch (_) { /* keep currentLocator */ }
    currentLocator = locator;

    try {
      await ensureSelectionInEditor(currentLocator);
      await page.keyboard.insertText(chunk);
    } catch (insertErr) {
      logger.warn("LinkedIn typeInChunks: insertText failed mid-chunk", {
        chunkIndex: i,
        chunkLength: chunk.length,
        error: insertErr.message,
      });
      return false;
    }
    await humanDelay(settleMs, settleMs + 80);

    // Verify cumulative prefix landed. If the editor's text doesn't contain
    // what we've typed so far, abort and let the caller fall back.
    const expectedSoFar = chunks.slice(0, i + 1).join("");
    const actual = normalizeWS(await getEditableText(currentLocator));
    if (!actual.includes(normalizeWS(expectedSoFar))) {
      // If only the last chunk is missing, retry it once. Otherwise abort.
      if (i > 0) {
        const expectedPrev = chunks.slice(0, i).join("");
        const actualPrev = normalizeWS(await getEditableText(currentLocator));
        if (actualPrev.includes(normalizeWS(expectedPrev))) {
          // Previous chunks landed — retry just this chunk.
          try {
            await ensureSelectionInEditor(currentLocator);
            await page.keyboard.insertText(chunk);
            await humanDelay(settleMs, settleMs + 80);
            const actual2 = normalizeWS(await getEditableText(currentLocator));
            if (!actual2.includes(normalizeWS(expectedSoFar))) {
              return false;
            }
            continue;
          } catch (_) {
            return false;
          }
        }
      }
      return false;
    }
  }
  return true;
}

/**
 * Reliable message entry for LinkedIn's DM composer.
 *
 * Uses atomic text injection strategies that work with React's contenteditable:
 *   1. Primary: page.keyboard.insertText() — single CDP command, atomic
 *   2. Fallback: typeInChunks() — chunked insertText for long messages
 *   3. Fallback: pasteTextViaClipboard() — synthetic paste with proper events
 *   4. Fallback: setEditorTextWithDomEvents() — direct DOM + React events
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

    // Step 3b: Chunked insertText — for long messages, a single atomic
    // insertText call can silently truncate past LinkedIn's editor buffer
    // (or React's beforeinput handler may preventDefault on long inserts).
    // Splitting into ~500-char chunks at whitespace boundaries and
    // re-locating the editor between chunks gives the editor time to
    // reconcile React state with the DOM. This is the missing middle
    // ground between "atomic single shot" and "per-character loop".
    if (value.length > 600) {
      logger.info(
        "LinkedIn typeLikeHuman: long text detected, trying chunked insertText",
        { length: value.length },
      );
      try {
        const chunkedOk = await typeInChunks(page, locator, value, {
          chunkSize: 500,
          settleMs: 120,
        });
        if (chunkedOk) {
          actual = normalizeWS(await getEditableText(locator));
          if (actual.includes(valueNorm)) {
            return true;
          }
        }
      } catch (chunkErr) {
        logger.warn(
          `LinkedIn typeLikeHuman: chunked insertText failed: ${chunkErr.message}`,
        );
      }
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

module.exports = {
  typeFast,
  typeInChunks,
  typeLikeHuman,
};

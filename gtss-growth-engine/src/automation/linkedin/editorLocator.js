/**
 * LinkedIn DM Editor — Locator & Recipient Verification
 * getActiveEditorLocator returns a stable locator for the editor inside the
 * current conversation overlay; verifyModalRecipient re-reads the recipient
 * name from the active modal's header as a defense-in-depth against
 * wrong-recipient sends.
 * Extracted from the original linkedin.js for maintainability.
 */

/**
 * Returns a stable locator for the active editor inside the current conversation overlay.
 * Scopes selectors inside a temporary tag to avoid targeting hidden/minimized dialogues.
 */
async function getActiveEditorLocator(page, editorMatch) {
  const overlayTagged = await editorMatch.locator
    .evaluate((editor) => {
      const overlay = editor.closest(
        '.msg-overlay-conversation-bubble, .msg-convo-wrapper, [role="dialog"], .artdeco-modal--type-is-messaging, .msg-form',
      );
      if (overlay) {
        overlay.setAttribute("data-gtss-active-overlay", "true");
        return true;
      }
      return false;
    })
    .catch(() => false);

  const scope = overlayTagged ? '[data-gtss-active-overlay="true"]' : "";

  const selectors = [
    '.msg-form__contenteditable[contenteditable="true"]',
    '.msg-form [contenteditable="true"]:not([class*="subject"])',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-label*="Write" i]',
    '[contenteditable="true"][data-placeholder*="message" i]',
    '[contenteditable="true"][data-placeholder*="Write" i]',
    '[contenteditable="true"][aria-placeholder*="message" i]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    "textarea",
  ];

  for (const sel of selectors) {
    const fullSelector = scope ? `${scope} ${sel}` : sel;
    const locator = page.locator(fullSelector).first();
    const isVisible = await locator
      .isVisible({ timeout: 100 })
      .catch(() => false);
    if (isVisible) {
      const isSubject = await locator
        .evaluate((el) => {
          const hint = [
            el.getAttribute("aria-label") || "",
            el.getAttribute("placeholder") || "",
            el.getAttribute("data-placeholder") || "",
            el.getAttribute("name") || "",
            el.className || "",
          ]
            .join(" ")
            .toLowerCase();
          return (
            /subject|recipient|\bto\b|people/.test(hint) &&
            !/message|write|reply/.test(hint)
          );
        })
        .catch(() => false);

      if (!isSubject) {
        return locator;
      }
    }
  }

  return editorMatch.locator;
}

/**
 * Verify the active messaging modal's recipient matches the expected lead.
 *
 * CRITICAL DEFENSE-IN-DEPTH against wrong-recipient sends. Even with the
 * modal-aware editor selection in findBestDmEditor(), a future LinkedIn DOM
 * change could regress that logic. This helper reads the recipient name
 * directly from the active modal's header (using a comprehensive list of
 * LinkedIn's known recipient-name selectors) and compares it to the expected
 * lead name. If they don't match, the caller MUST abort the send.
 *
 * Returns:
 *   { ok: true, actual?: string }            — recipient matches (or no
 *                                              expectedName was provided)
 *   { ok: true, warning: string, actual: null } — could not extract a
 *                                              recipient name from the modal;
 *                                              proceed (scoping already
 *                                              ensures we're in the right
 *                                              modal) but log the warning
 *   { ok: false, reason: string, actual: string, expected: string } — mismatch
 *
 * @param {object} pageOrFrame    - Playwright Page or Frame (msgCtx)
 * @param {object} editorLocator  - Locator for the chosen DM editor
 * @param {string} expectedName   - Lead name from the queue
 */
async function verifyModalRecipient(pageOrFrame, editorLocator, expectedName) {
  if (!expectedName) return { ok: true };

  const normalise = (s) =>
    String(s || "")
      .trim()
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^a-z]/g, "");

  // Defense-in-depth: apply the same metadata denylist used by the
  // pre-navigation and post-navigation identity guards. If the expected
  // name is garbage (e.g. "7 other mutual connections", "500+ followers"),
  // we cannot verify the recipient — fail CLOSED. Previously this branch
  // returned { ok: true }, which let "7 other mutual connections" pass
  // through as a "match" for any profile name.
  const METADATA_DENYLIST_VERIFY = new Set([
    "mutual", "followers", "follower", "connections", "connection",
    "other", "and", "are", "with", "plus", "more",
  ]);
  const extractCleanFirst = (raw) => {
    if (!raw) return "";
    let s = String(raw)
      .replace(/\s+are\s+mutual\s+connections?.*$/i, "")
      .replace(/,?\s*\d+\s+(other\s+)?mutual\s+connections?.*$/i, "")
      .replace(/,?\s*\d+\s+mutual$/i, "")
      .trim();
    if (!s) return "";
    const andSplit = s.split(/\s+(?:&|and)\s+/i);
    s = andSplit[andSplit.length - 1].trim();
    if (!s) return "";
    const tokens = s.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const cleaned = t.replace(/[^a-zA-Z]/g, "").toLowerCase();
      if (cleaned.length < 2) continue;
      if (/^(mr|mrs|ms|dr|prof|sir|madam)$/i.test(cleaned)) continue;
      if (METADATA_DENYLIST_VERIFY.has(cleaned)) continue;
      return cleaned;
    }
    return "";
  };

  const expectedFirst = extractCleanFirst(expectedName);

  // Fail CLOSED: if a leadName was supplied but we cannot extract a real
  // first name from it, the lead data is corrupt — refuse to verify.
  if (!expectedFirst) {
    return {
      ok: false,
      reason:
        `Cannot parse first name from leadName "${expectedName}". ` +
        `Refusing to verify modal recipient — lead data is corrupt. ` +
        `Send aborted by recipient-verification guard (fail-closed).`,
      actual: null,
      expected: expectedName,
    };
  }

  const overlayInfo = await editorLocator
    .evaluate((editor) => {
      // Walk up to the OUTERMOST overlay ancestor (not the first match).
      // The editor's closest .msg-form matches first, but the recipient
      // name header lives OUTSIDE the form, in the outer modal container.
      // We must therefore find the outermost .msg-overlay-conversation-bubble
      // / [role="dialog"] / .artdeco-modal--type-is-messaging ancestor.
      const overlaySelectors =
        '.msg-overlay-conversation-bubble, .msg-convo-wrapper, [role="dialog"], .artdeco-modal--type-is-messaging';
      let node = editor;
      let outermostOverlay = null;
      while (node && node !== document.body) {
        if (node.matches && node.matches(overlaySelectors)) {
          outermostOverlay = node; // keep going — we want the OUTERMOST
        }
        node = node.parentElement;
      }
      const overlay = outermostOverlay;
      if (!overlay) return { found: false };

      // Comprehensive list of LinkedIn recipient-name header selectors.
      // Listed in order of preference (most specific first).
      const recipientSelectors = [
        '.msg-overlay-bubble-header__name',
        '.msg-overlay-conversation-bubble__name',
        '.msg-convo-wrapper__name',
        '.msg-form__recipient-name',
        '[data-control-name="overlay.header"] [data-control-name="overlay.participant"]',
        '.msg-overlay-bubble-header a[href*="/in/"]',
        '.msg-convo-wrapper a[href*="/in/"]',
        // Fallback: any <a> with /in/ link inside the modal header is usually
        // the recipient's profile link.
        'header a[href*="/in/"]',
        '.msg-overlay-bubble-header a',
        // For the alternate compose modal: there is often a recipient chip
        // labelled "To: <name>" with the name in a span.
        '[data-control-name="to"] [data-control-name="overlay.participant"]',
        '.msg-form__recipient-chip',
      ];

      for (const sel of recipientSelectors) {
        const node = overlay.querySelector(sel);
        if (node) {
          const text = (node.textContent || node.getAttribute("title") || "")
            .trim();
        // This is LinkedIn's own account-menu label, not the person in the
        // composer. It was causing false wrong-recipient blocks on Premium
        // modals where no actual editor/recipient exists.
        if (/^view\s+.+['’]s\s+profile$/i.test(text)) continue;
        if (text && text.length > 0 && text.length < 100) {
            return { found: true, name: text, selector: sel };
          }
        }
      }

      return { found: false };
    })
    .catch(() => ({ found: false }));

  if (!overlayInfo.found) {
    // Cannot confidently extract a recipient name. Don't fail — the
    // modal-aware editor selection already ensures we're in the correct
    // modal. Log a warning so it's visible if a wrong-recipient bug is
    // later reported.
    return {
      ok: true,
      warning: "recipient_name_not_found_in_modal",
      actual: null,
    };
  }

  const actualFirst = normalise(overlayInfo.name);

  if (actualFirst && actualFirst !== expectedFirst) {
    return {
      ok: false,
      reason:
        `Modal recipient "${overlayInfo.name}" does not match expected lead "${expectedName}". ` +
        `Send aborted by recipient-verification guard.`,
      actual: overlayInfo.name,
      expected: expectedName,
    };
  }

  return { ok: true, actual: overlayInfo.name };
}

module.exports = {
  getActiveEditorLocator,
  verifyModalRecipient,
};

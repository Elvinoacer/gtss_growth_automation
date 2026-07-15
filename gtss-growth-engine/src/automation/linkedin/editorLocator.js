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
 *   { ok: false, reason, actual: null }         — recipient cannot be
 *                                              extracted. Sending without a
 *                                              positive recipient binding is
 *                                              unsafe, so the caller must
 *                                              abort rather than guessing.
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

      // LinkedIn injects presence/status chrome next to the recipient header
      // ("Status is reachable", "Active now", etc.). Those are NOT names.
      const isNotPersonName = (raw) => {
        const t = String(raw || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!t || t.length < 2 || t.length > 80) return true;
        if (/^view\s+.+['’]s\s+profile$/i.test(t)) return true;
        if (
          /status is reachable|active now|available on mobile|available now|presence|last seen|open to work/i.test(
            t,
          )
        ) {
          return true;
        }
        if (
          /^(status|reachable|available|online|offline|away|premium|message|messaging|new message|compose)$/i.test(
            t,
          )
        ) {
          return true;
        }
        // Pure emoji / punctuation
        if (!/[a-zA-Z]{2,}/.test(t)) return true;
        return false;
      };

      for (const sel of recipientSelectors) {
        const node = overlay.querySelector(sel);
        if (node) {
          const text = (node.textContent || node.getAttribute("title") || "")
            .trim();
          if (isNotPersonName(text)) continue;
          if (text && text.length > 0 && text.length < 100) {
            return { found: true, name: text, selector: sel };
          }
        }
      }

      // Fallback: any /in/ profile link in the overlay header region that
      // looks like a real person name.
      const profileLinks = overlay.querySelectorAll('a[href*="/in/"]');
      for (const link of profileLinks) {
        const text = (link.textContent || link.getAttribute("title") || "")
          .replace(/\s+/g, " ")
          .trim();
        if (isNotPersonName(text)) continue;
        // Prefer links near the top of the overlay (header).
        const rect = link.getBoundingClientRect();
        const oRect = overlay.getBoundingClientRect();
        if (rect.top - oRect.top > 120) continue;
        return { found: true, name: text, selector: "a[href*=\"/in/\"]" };
      }

      return { found: false };
    })
    .catch(() => ({ found: false }));

  if (!overlayInfo.found) {
    // A modal-scoped editor is necessary, but it is not sufficient: LinkedIn
    // can retain an older conversation bubble while mounting a new composer.
    // The production "Status is offline" case took this fail-open branch and
    // sent despite having no evidence of who owned the editor. Never guess.
    return {
      ok: false,
      reason:
        `Cannot extract a recipient name from the active message composer for expected lead "${expectedName}". ` +
        "Send aborted by recipient-verification guard (fail-closed).",
      actual: null,
      expected: expectedName,
    };
  }

  // Double-check: if the extracted "name" is still chrome text, treat as
  // not found rather than a hard mismatch (production log: "Status is reachable").
  const actualRaw = String(overlayInfo.name || "").trim();
  if (
    /status is reachable|active now|available on mobile|^status\b/i.test(
      actualRaw,
    )
  ) {
    return {
      ok: false,
      reason:
        `Active message composer header is not a person name ("${actualRaw}") for expected lead "${expectedName}". ` +
        "Send aborted by recipient-verification guard (fail-closed).",
      actual: null,
      expected: expectedName,
    };
  }

  const actualFirst = normalise(overlayInfo.name);

  // Also extract first name from actual with same denylist so
  // "Angela onsarigo · 1st" still yields "angela".
  const actualClean = extractCleanFirst(overlayInfo.name) || actualFirst;

  if (actualClean && actualClean !== expectedFirst) {
    // Soft-match: if expected is a prefix of actual or vice versa (nicknames /
    // middle names), allow.
    if (
      actualClean.startsWith(expectedFirst) ||
      expectedFirst.startsWith(actualClean)
    ) {
      return { ok: true, actual: overlayInfo.name };
    }
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

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
      // Prefer a conversation-scoped container (bubble / detail column) so
      // later scoped queries stay on the active thread, not the whole page.
      const overlay = editor.closest(
        [
          ".msg-overlay-conversation-bubble",
          ".msg-convo-wrapper",
          '[role="dialog"]',
          ".artdeco-modal--type-is-messaging",
          ".scaffold-layout__detail",
          ".msg-s-message-list-container",
          ".msg-form",
        ].join(", "),
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
 * @param {object} options
 * @param {string|null} options.composeUrl - The Message href read from the
 *   verified profile CTA before navigating to the full-page composer.
 */
async function verifyModalRecipient(
  pageOrFrame,
  editorLocator,
  expectedName,
  { composeUrl = null } = {},
) {
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

  // Full-page /messaging/compose?recipient=… is a stronger binding than any
  // DOM name scrape. Prefer it when the committed route still points at the
  // same profile URN we opened from the identity-verified Message CTA.
  // This is especially important for EXISTING conversations: the thread
  // contains the sender's own name (e.g. "elvin Juma") in message-group
  // headers, which older scrapers misread as the recipient.
  const composeUrlProof = (() => {
    try {
      if (!composeUrl) return null;
      const source = new URL(composeUrl);
      const current = new URL(pageOrFrame.url());
      const sourceRecipient =
        source.searchParams.get("recipient") ||
        source.searchParams.get("profileUrn");
      const currentRecipient =
        current.searchParams.get("recipient") ||
        current.searchParams.get("profileUrn");
      if (
        sourceRecipient &&
        currentRecipient &&
        sourceRecipient === currentRecipient &&
        /\/messaging\/(compose|thread)/i.test(current.pathname)
      ) {
        return {
          ok: true,
          actual: `compose recipient ${currentRecipient} verified from the profile Message link`,
          via: "compose_url",
        };
      }
    } catch (_) {
      // ignore URL parse errors
    }
    return null;
  })();

  const overlayInfo = await editorLocator
    .evaluate((editor) => {
      // Walk up looking for the best messaging surface. Prefer a *specific*
      // conversation container over the outermost generic dialog so we do not
      // pull names from the left-hand conversation list or page chrome.
      //
      // Prefer (in order of specificity when walking UP):
      //   1. bubble / dialog / convo wrapper (overlay DM)
      //   2. scaffold-layout__detail (full-page active thread column)
      //   3. msg-s-message-list-container / msg-thread
      // Never use bare `main` — it includes the inbox list.
      const preferredOverlaySelectors = [
        ".msg-overlay-conversation-bubble",
        ".msg-convo-wrapper",
        ".artdeco-modal--type-is-messaging",
        '[role="dialog"]',
        ".scaffold-layout__detail",
        ".msg-s-message-list-container",
        ".msg-thread",
        ".msg-s-message-list",
      ];
      let node = editor;
      let bestOverlay = null;
      let bestRank = Infinity;
      while (node && node !== document.body) {
        if (node.matches) {
          for (let i = 0; i < preferredOverlaySelectors.length; i++) {
            if (node.matches(preferredOverlaySelectors[i]) && i < bestRank) {
              bestOverlay = node;
              bestRank = i;
              break;
            }
          }
        }
        node = node.parentElement;
      }
      // Fall back: walk from editor to the nearest form, then its parent
      // section/article so compose chips living next to the form are in scope.
      let overlay = bestOverlay;
      if (!overlay) {
        const form = editor.closest(".msg-form, form");
        overlay =
          (form &&
            (form.closest(
              ".scaffold-layout__detail, .msg-convo-wrapper, [role='dialog'], section, article",
            ) ||
              form.parentElement)) ||
          null;
      }
      if (!overlay) return { found: false };

      // Message-list chrome must NEVER be treated as the recipient. On
      // existing threads, `.msg-s-message-group__name` is the *sender*
      // (often the logged-in user, e.g. "elvin Juma") — that was the
      // production wrong-recipient false positive.
      const isInsideMessageList = (el) =>
        Boolean(
          el.closest(
            [
              ".msg-s-event-listitem",
              ".msg-s-message-group",
              ".msg-s-message-list-content",
              ".msg-s-message-list",
              ".msg-s-event-listitem__body",
              '[data-view-name="message-list-item"]',
              ".msg-s-message-list__typing-indicator-container",
            ].join(", "),
          ),
        );

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
          /^(status|reachable|available|online|offline|away|premium|message|messaging|new message|compose|send|you)$/i.test(
            t,
          )
        ) {
          return true;
        }
        // Pure emoji / punctuation
        if (!/[a-zA-Z]{2,}/.test(t)) return true;
        return false;
      };

      const readName = (el) => {
        if (!el || isInsideMessageList(el)) return null;
        const text = (
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .replace(/[×x]\s*$/i, "") // strip chip "remove" glyph
          .trim();
        if (isNotPersonName(text)) return null;
        if (text.length === 0 || text.length >= 100) return null;
        return text;
      };

      // High-confidence recipient selectors — profile card (existing thread)
      // and compose recipient chips (new / compose-URL flows) first.
      // These beat generic header / profile-link fallbacks that can hit the
      // logged-in user's own name on previously messaged threads.
      const recipientSelectors = [
        // Existing conversation profile card (full-page messaging)
        ".msg-s-profile-card .artdeco-entity-lockup__title .truncate",
        ".msg-s-profile-card .artdeco-entity-lockup__title",
        ".msg-s-profile-card a.profile-card-one-to-one__profile-link",
        '.msg-s-profile-card a[href*="/in/"]',
        // Compose / typeahead recipient chips (full-page compose + overlay)
        ".msg-form__recipient-chip",
        ".msg-connections-typeahead__recipient-token",
        ".msg-form__recipients .artdeco-pill__text",
        ".msg-form__recipients .artdeco-pill",
        ".msg-form__recipients [data-test-recipient]",
        ".msg-form__recipients li",
        '.msg-form__recipients span[aria-label]',
        // Classic overlay bubble header
        ".msg-overlay-bubble-header__name",
        ".msg-overlay-conversation-bubble__name",
        ".msg-convo-wrapper__name",
        ".msg-form__recipient-name",
        '[data-control-name="overlay.header"] [data-control-name="overlay.participant"]',
        '.msg-overlay-bubble-header a[href*="/in/"]',
        '.msg-convo-wrapper a[href*="/in/"]',
        "header a[href*=\"/in/\"]",
        ".msg-overlay-bubble-header a",
        '[data-control-name="to"] [data-control-name="overlay.participant"]',
      ];

      for (const sel of recipientSelectors) {
        const nodes = overlay.querySelectorAll(sel);
        for (const n of nodes) {
          const text = readName(n);
          if (text) {
            return {
              found: true,
              name: text,
              selector: sel,
              confidence: "high",
            };
          }
        }
      }

      // Fallback: /in/ profile links in the HEADER region of the overlay only.
      // Skip anything inside the message list (sender avatars / names).
      const oRect = overlay.getBoundingClientRect();
      const profileLinks = overlay.querySelectorAll('a[href*="/in/"]');
      for (const link of profileLinks) {
        if (isInsideMessageList(link)) continue;
        // Skip links that live in the message form footer / attachment row.
        if (link.closest(".msg-form__footer, .msg-form__left-actions, .msg-form__right-actions")) {
          continue;
        }
        const text = readName(link);
        if (!text) continue;
        const rect = link.getBoundingClientRect();
        // Header band: top ~140px of the conversation column.
        if (rect.top - oRect.top > 140) continue;
        return {
          found: true,
          name: text,
          selector: 'a[href*="/in/"]',
          confidence: "medium",
        };
      }

      return { found: false };
    })
    .catch(() => ({ found: false }));

  if (!overlayInfo.found) {
    if (composeUrlProof) return composeUrlProof;

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
    if (composeUrlProof) return composeUrlProof;
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

    // DOM scraped a person name that does not match the lead — but on a
    // full-page compose/thread whose query string still binds to the same
    // profile URN we opened from the verified Message CTA, the scrape is
    // almost certainly a message-sender false positive (existing thread
    // shows "elvin Juma" as the sender of prior messages). Trust the URL.
    if (composeUrlProof) {
      return {
        ok: true,
        actual: composeUrlProof.actual,
        scrapedNameIgnored: overlayInfo.name,
        via: "compose_url_override_mismatch_scrape",
      };
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

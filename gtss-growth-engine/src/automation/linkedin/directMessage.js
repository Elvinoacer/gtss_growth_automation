/**
 * LinkedIn Direct Message
 * sendDirectMessage — the main DM flow for 1st-degree connections on LinkedIn.
 * This single function is intentionally kept in its own file (it spans
 * ~830 lines and orchestrates almost every other module in this directory).
 * Extracted from the original linkedin.js for maintainability.
 *
 * Throughput-optimised flow:
 *   navigate → [profile name verify] → message button? no → skip
 *             ↓ yes
 *           click → premium popup? yes → skip
 *             ↓ no
 *           find editor (1 attempt) → not found → skip
 *             ↓ found
 *           typeFast (fill) → find send button → click
 *             ↓
 *           wait 500 ms → error banner? → fail / assume sent → next profile
 *
 * @param {object} page         - Playwright page instance
 * @param {string} profileUrl   - LinkedIn profile URL to navigate to
 * @param {string} message      - Message body to send
 * @param {function} emit       - Logging callback
 * @param {string|null} leadName - Expected lead name for identity verification (optional)
 */

const { humanDelay, closeStrayTabs } = require("../browserBase");
const logger = require("../../utils/logger");
const diag = require("../linkedinDiagnostics");

const { bringLinkedInPageToFront } = require("./focus");
const { installNoNewTabsGuard } = require("./navGuards");
const {
  dismissAllMessagingUI,
  dismissLinkedInNavDropdowns,
} = require("./dismissUI");
const { findProfileMessageAction } = require("./profileActions");
const { detectMessagingContext } = require("./messagingFrame");
const { detectMessagingBlocked } = require("./detection");
const { waitForEditorInteractive } = require("./dmEditorInteraction");
const { waitForDmEditor } = require("./dmEditorDetection");
const {
  getActiveEditorLocator,
  verifyModalRecipient,
} = require("./editorLocator");
const { typeLikeHuman } = require("./typeStrategies");
const {
  messageSnippet,
  normalizeEditableText,
  getEditableText,
  getEditorState,
  ensureSelectionInEditor,
} = require("./editorText");
const { verifyDmSent, forceClearDmDraft } = require("./editorVerification");
const {
  findSendButtonForEditor,
  clickSendButtonRobust,
} = require("./sendActions");

async function sendDirectMessage(
  page,
  profileUrl,
  message,
  emit,
  leadName = null,
) {
  // msgCtx tracks the execution context: either the interop-iframe frame
  // (overlay mode) or the main page (full-page /messaging/ mode).
  // This variable is declared here so it is accessible in the finally block.
  let msgCtx = page;
  let removeNoNewTabsGuard = () => {};

  try {
    // ── Pre-flight: bring tab to OS focus ─────────────────────────────────
    // In CDP-mode multi-tab sessions the tab is in the background and
    // document.hasFocus() is false, so all keyboard events are dropped.
    await bringLinkedInPageToFront(page);
    removeNoNewTabsGuard = installNoNewTabsGuard(page, emit);
    await closeStrayTabs(page.context(), "linkedin").catch(() => {});

    // ── 0. Pre-navigation cleanup ────────────────────────────────────────────
    // Dismiss any stale messaging UI from a previous profile's DM attempt.
    await dismissAllMessagingUI(page);

    // ── 0-pre. Pre-navigation safety guards (fail BEFORE wasting a page load) ─
    // Two cheap checks that only need `leadName` and `message`, both of which
    // we already have in hand. Failing here saves a full navigation cycle
    // and prevents the "navigated to wrong profile" symptom entirely.
    {
      const normalise0 = (name) =>
        String(name || "")
          .trim()
          .split(/\s+/)[0]
          .toLowerCase()
          .replace(/[^a-z]/g, "");

      // Garbage-name detector. Lead names that consist solely of relationship
      // metadata (e.g. "7 other mutual connections", "500+ followers",
      // "2 mutual", "Peter, Francis and 24 other mutual connections") are
      // never safe to message under — we cannot tell who the actual recipient
      // is supposed to be. The discovery layer tries to filter these out, but
      // some slip through (legacy data, manual imports, partial scrapes).
      // Refuse to send when the lead name is unparseable garbage.
      const looksLikeMetadata = (raw) => {
        const s = String(raw || "").trim().toLowerCase();
        if (!s) return true;
        // Pure metadata patterns — never a real person's name.
        const metadataPatterns = [
          /^\d+\s+(other\s+)?mutual\s+connections?$/i,
          /^\d+\s+(other\s+)?mutual$/i,
          /^\d+\s+followers?$/i,
          /^\d+\s+connections?$/i,
          /^\d+\+(st|nd|rd|th)?\s+(mutual\s+)?connections?$/i,
          /^(mutual\s+connections?|followers?|connections?)$/i,
          /^[\d,.+\s]+\+?\s*(mutual|followers?|connections?)?$/i,
        ];
        if (metadataPatterns.some((re) => re.test(s))) return true;
        // The ONLY acceptable form of "mutual connections" in a leadName is
        // the exact "A & B are mutual connections" / "A and B are mutual
        // connections" pattern — the profile_url owner is always B (the
        // second name). Anything else ("A, B and 24 other mutual
        // connections", "X mutual", etc.) is ambiguous → garbage.
        if (/\bmutual\s+connections?\b/i.test(s) || /\bare\s+mutual\b/i.test(s)) {
          // Accept ONLY "NameA & NameB are mutual connections" or
          // "NameA and NameB are mutual connections" (2 distinct names).
          const pairMatch = s.match(
            /^([a-z][a-z.'-]+(?:\s+[a-z][a-z.'-]+)*)\s+(?:&|and)\s+([a-z][a-z.'-]+(?:\s+[a-z][a-z.'-]+)*)\s+are\s+mutual\s+connections?$/i,
          );
          if (pairMatch) {
            // The "A & B are mutual connections" form is unambiguous —
            // NOT metadata. extractFirstName will return B.
            return false;
          }
          // Any other "mutual connections" appearance is ambiguous.
          return true;
        }
        return false;
      };

      // Words that must never be returned as a "first name" — they are
      // relationship-metadata keywords that slipped through extraction.
      const METADATA_DENYLIST = new Set([
        "mutual", "followers", "follower", "connections", "connection",
        "other", "and", "are", "with", "plus", "more",
      ]);

      // Extract the best-effort single first-name from a (possibly dirty)
      // leadName. Returns "" if nothing name-like could be extracted.
      const extractFirstName = (raw) => {
        if (!raw) return "";
        let s = String(raw)
          // Strip trailing "are mutual connections..." tail.
          .replace(/\s+are\s+mutual\s+connections?.*$/i, "")
          // Strip trailing "X other mutual connections" fragments.
          .replace(/,?\s*\d+\s+(other\s+)?mutual\s+connections?.*$/i, "")
          // Strip trailing "X mutual" fragments.
          .replace(/,?\s*\d+\s+mutual$/i, "")
          .trim();
        if (!s) return "";
        // Handle "A & B" / "A and B" — last name is the canonical one
        // (matches the profile_url's owner).
        const andSplit = s.split(/\s+(?:&|and)\s+/i);
        s = andSplit[andSplit.length - 1].trim();
        if (!s) return "";
        // Take the first whitespace-delimited token, drop honorifics and
        // metadata keywords.
        const tokens = s.split(/\s+/).filter(Boolean);
        for (const t of tokens) {
          const cleaned = t.replace(/[^a-zA-Z]/g, "").toLowerCase();
          if (cleaned.length < 2) continue;
          if (/^(mr|mrs|ms|dr|prof|sir|madam)$/i.test(cleaned)) continue;
          if (METADATA_DENYLIST.has(cleaned)) continue;
          return cleaned;
        }
        return "";
      };

      const intendedFirst = extractFirstName(leadName);

      // Guard 0-pre-A: refuse to send when leadName is metadata garbage.
      // We CANNOT safely verify the recipient's identity, so sending would
      // risk messaging a stranger. Fail closed.
      if (leadName && looksLikeMetadata(leadName)) {
        emit(
          "error",
          `Refusing to send DM: lead name "${leadName}" is relationship metadata, ` +
            `not a real person's name. The intended recipient cannot be verified. ` +
            `Aborting BEFORE navigation to prevent sending to the wrong person.`,
        );
        logger.error("LinkedIn DM Safety Block — garbage lead name", {
          profileUrl,
          leadName,
          messageSnippet: messageSnippet(message),
        });
        return {
          outcome: "failed",
          reason:
            `Lead name "${leadName}" is metadata, not a person's name. ` +
            `Send aborted by pre-navigation identity guard.`,
        };
      }

      // Guard 0-pre-B: cross-check message greeting vs leadName BEFORE
      // navigating. If the message says "Hi Duncan" but leadName is "Brian
      // Example", the lead record is internally inconsistent (wrong
      // profile_url, wrong message body, or wrong name) — abort now.
      if (intendedFirst && message) {
        const greetingMatch0 = message.match(
          /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/i,
        );
        if (greetingMatch0) {
          const greetingName0 = normalise0(greetingMatch0[1]);
          if (greetingName0 && greetingName0 !== intendedFirst) {
            emit(
              "error",
              `Pre-navigation mismatch: message greets "${greetingMatch0[1]}" ` +
                `but lead is "${leadName}". Aborting BEFORE navigation — ` +
                `lead record is internally inconsistent.`,
            );
            logger.error("LinkedIn DM Pre-Navigation Safety Block", {
              profileUrl,
              leadName,
              greetingName: greetingMatch0[1],
              messageSnippet: messageSnippet(message),
            });
            return {
              outcome: "failed",
              reason:
                `Pre-navigation mismatch: greeting="${greetingMatch0[1]}" vs leadName="${leadName}". ` +
                `Send aborted before navigation by pre-flight content guard.`,
            };
          }
        }
      }
    }

    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Performance: domcontentloaded already fires when the DOM is ready.
    // 200-350ms is enough for LinkedIn's React to mount profile headers;
    // 500-900ms was excessive.
    await humanDelay(200, 350);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // ── 0-post-nav. Dismiss any LinkedIn top-nav dropdown that may have      ─
    // auto-opened on navigation (e.g. "For Business" / "My Apps"). This is a
    // defensive measure — regardless of what opened it, we close it before
    // looking for the Message button.
    await dismissLinkedInNavDropdowns(page);

    // ── 0a. Profile identity & message-content verification ──────────────────
    // Two safety checks before we type a single character:
    //   A. If leadName was passed, verify the profile page h1/h2 matches it.
    //      FAIL CLOSED: if leadName was passed but we cannot parse a real
    //      first name from it (after stripping metadata fragments), abort.
    //      Previously this branch silently passed through, which is how
    //      "7 other mutual connections" got verified as a match for
    //      "Shadrack Kipkirui Korir".
    //   B. ALWAYS check the message body for a greeting name (e.g. "Hi Peter,")
    //      and verify it matches the profile page.
    {
      const normalise = (name) =>
        String(name || "")
          .trim()
          .split(/\s+/)[0]
          .toLowerCase()
          .replace(/[^a-z]/g, "");

      // Robust identity-name cleanup. Strips trailing "are mutual connections",
      // "X other mutual connections", and "X mutual" fragments, then takes
      // the last name from "A & B" / "A and B" pairs (the profile_url owner).
      // Uses the same metadata denylist as the pre-navigation guard so both
      // checks agree on what counts as a real first name.
      const METADATA_DENYLIST_A = new Set([
        "mutual", "followers", "follower", "connections", "connection",
        "other", "and", "are", "with", "plus", "more",
      ]);
      const extractIdentityName = (raw) => {
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
          if (METADATA_DENYLIST_A.has(cleaned)) continue;
          return cleaned;
        }
        return "";
      };

      const identityName = extractIdentityName(leadName) || leadName || "";

      let pageProfileName = null;
      try {
        // LinkedIn's new UI uses obfuscated class names on h1/h2 — use broad
        // selectors: first try the exact old class, then any h1/h2 in main.
        pageProfileName = await page
          .locator("h1.text-heading-xlarge, main h1, main h2")
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);
      } catch (_) {}

      const pageFirst = normalise(pageProfileName);
      const expectedFirst = normalise(identityName);

      // Check A: leadName vs profile page name — FAIL CLOSED.
      // If leadName was supplied but we couldn't extract a real first name
      // from it, the lead data is corrupt — refuse to send rather than
      // silently passing (which is the bug that let "7 other mutual
      // connections" match "Shadrack Kipkirui Korir").
      if (leadName && !expectedFirst) {
        emit(
          "error",
          `Cannot verify identity: leadName "${leadName}" could not be parsed ` +
            `into a real first name. Aborting to prevent sending to the wrong person.`,
        );
        logger.error("LinkedIn DM Safety Block — unparseable leadName", {
          profileUrl,
          leadName,
          pageProfileName: (pageProfileName || "").trim(),
        });
        return {
          outcome: "failed",
          reason:
            `Cannot parse first name from leadName "${leadName}". ` +
            `Send aborted by identity guard (fail-closed).`,
        };
      }

      if (leadName && expectedFirst && pageFirst) {
        if (pageFirst !== expectedFirst) {
          emit(
            "error",
            `Profile identity mismatch: page shows "${(pageProfileName || "").trim()}" ` +
              `but expected "${identityName}". Aborting to prevent wrong-person DM.`,
          );
          logger.error("LinkedIn DM Safety Block", {
            profileUrl,
            expectedLeadName: identityName,
            pageProfileName: (pageProfileName || "").trim(),
          });
          return {
            outcome: "failed",
            reason:
              `Profile name mismatch: page="${(pageProfileName || "").trim()}" vs expected="${identityName}". ` +
              `Send aborted by identity guard.`,
          };
        }
        emit(
          "info",
          `Profile identity verified: "${(pageProfileName || "").trim()}" matches lead "${identityName}".`,
        );
      }

      // Check B: message greeting name vs profile page name
      if (pageFirst && message) {
        const greetingMatch = message.match(
          /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/i,
        );
        if (greetingMatch) {
          const greetingName = normalise(greetingMatch[1]);
          if (greetingName && greetingName !== pageFirst) {
            emit(
              "error",
              `Message content mismatch: message greets "${greetingMatch[1]}" ` +
                `but profile is "${(pageProfileName || "").trim()}". ` +
                `Aborting to prevent sending wrong message to wrong person.`,
            );
            logger.error("LinkedIn DM Content Safety Block", {
              profileUrl,
              greetingName: greetingMatch[1],
              pageProfileName: (pageProfileName || "").trim(),
              messageSnippet: messageSnippet(message),
            });
            return {
              outcome: "failed",
              reason:
                `Message content mismatch: greeting="${greetingMatch[1]}" vs profile="${(pageProfileName || "").trim()}". ` +
                `Send aborted by content guard.`,
            };
          }
        }
      }
    }

    // ── 1. Message button ─────────────────────────────────────────────────────
    let messageMatch = await findProfileMessageAction(page, 2200);

    // If not found after initial load, scroll the page once to trigger lazy
    // rendering of the action buttons, then retry once more.
    if (!messageMatch) {
      emit(
        "info",
        "Message button not visible on first pass — scrolling and retrying...",
      );
      await page.evaluate(() =>
        window.scrollTo({ top: 200, behavior: "instant" }),
      );
      // Performance: 400-600ms was excessive for a scroll-triggered lazy
      // render. 150-250ms is enough for LinkedIn to render the action buttons.
      await humanDelay(150, 250);
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await humanDelay(120, 220);
      messageMatch = await findProfileMessageAction(page, 2000);
    }

    if (!messageMatch) {
      emit("warn", "No Message button — skipping profile.");
      return {
        outcome: "not_connected",
        reason: "Message button not visible — not a 1st-degree connection",
      };
    }

    // ── 2. Click Message ──────────────────────────────────────────────────────
    // Pre-click defense: if a LinkedIn top-nav dropdown ("For Business" /
    // "My Apps" / top-nav "More") opened between the previous step and now,
    // it could intercept the click. Dismiss it first.
    await dismissLinkedInNavDropdowns(page);

    emit("info", `Clicking Message (${messageMatch.selector})...`);
    // DOM-level click: avoids sticky-header interception when element is near viewport top.
    await messageMatch.locator.evaluate((el) => el.click()).catch(() => {});
    // Performance: LinkedIn's modal CSS animation completes in ~200-300ms.
    // 600-900ms was excessive; 250-400ms is enough for React to mount the
    // composer and for the editor to become interactive.
    await humanDelay(250, 400);
    await closeStrayTabs(page.context(), "linkedin").catch(() => {});
    await diag.capture(page, "after-message-click");

    // Post-click defense: dismiss any top-nav dropdown that may have popped
    // open as a side-effect of the Message click (LinkedIn's React tree
    // sometimes re-flows and re-opens sticky nav menus).
    await dismissLinkedInNavDropdowns(page);

    // ── 2a. Detect execution context: full-page / iframe / shadow DOM ────────
    //
    // LinkedIn renders the DM composer in one of three modes. We must pick the
    // correct context (page vs iframe) before any locator/evaluate call, otherwise
    // findBestDmEditor runs page.evaluate() which does NOT pierce iframes and
    // returns null (or matches a wrong editor in the main page like a search box).
    //
    // See detectMessagingContext() for the full rationale of why the previous
    // #interop-outlet visibility check was broken (it always returned true and
    // the iframe branch was never taken, causing all keyboard input to be
    // silently dropped when LinkedIn used the interop iframe).
    const ctxInfo = await detectMessagingContext(page, 5000);
    emit(
      "info",
      `Messaging context: mode=${ctxInfo.mode} (${ctxInfo.reason})`,
    );
    await diag.capture(page, "messaging-context-detected", {
      mode: ctxInfo.mode,
      reason: ctxInfo.reason,
    });

    let messagingFrame = null;

    if (ctxInfo.mode === "page") {
      msgCtx = page;
      // Performance: 400-700ms was excessive; the page-mode editor is
      // already mounted by the time detectMessagingContext returns.
      await humanDelay(150, 280);
    } else if (ctxInfo.mode === "iframe" && ctxInfo.frame) {
      messagingFrame = ctxInfo.frame;
      msgCtx = messagingFrame;
      // CRITICAL: patch document.hasFocus() inside the iframe too. React's
      // composer living in the iframe checks the IFRAME's document.hasFocus(),
      // not the parent page's. Without this patch, ALL keyboard input is
      // silently dropped — the exact "focus lands but typing fails" symptom.
      await bringLinkedInPageToFront(page, messagingFrame);
    } else {
      // shadow DOM mode — compose UI is in #interop-outlet's shadow root.
      // Playwright locators pierce open shadow DOMs natively, so msgCtx = page
      // is correct. But we still patch hasFocus() in any /preload/ iframe as a
      // belt-and-suspenders measure.
      msgCtx = page;
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        try {
          const fUrl = f.url();
          if (
            fUrl &&
            (fUrl.includes("/preload") || fUrl.includes("_bprMode"))
          ) {
            await bringLinkedInPageToFront(page, f);
            break;
          }
        } catch (_) {}
      }
    }

    // ── 3. Premium / blocked popup ────────────────────────────────────────────
    const blockedImmediately = await detectMessagingBlocked(page, 900);
    if (blockedImmediately) {
      emit("warn", blockedImmediately.reason);
      return blockedImmediately;
    }

    // ── 4. Wait for editor to be interactive ──────────────────────────────────
    const editorInteractive = await waitForEditorInteractive(msgCtx, 3000, messagingFrame);
    if (!editorInteractive) {
      emit("warn", "Editor not yet interactive — checking for premium block...");
      const blockedAfterWait = await detectMessagingBlocked(page, 500);
      if (blockedAfterWait) {
        emit("warn", blockedAfterWait.reason);
        return blockedAfterWait;
      }
    }

    // ── 5. Locate DM editor ───────────────────────────────────────────────────
    const editorMatch = await waitForDmEditor(msgCtx, null, 3);

    // Premium's interop modal can mount after the initial context/editor
    // probes. Check once more here, immediately before accepting any editor
    // or reading a recipient, so a Premium lead is skipped without typing,
    // retries, or a cooldown.
    const blockedBeforeEditorUse = await detectMessagingBlocked(page, 900);
    if (blockedBeforeEditorUse) {
      emit("warn", blockedBeforeEditorUse.reason);
      return blockedBeforeEditorUse;
    }

    if (!editorMatch) {
      emit("warn", "DM editor not found — skipping profile.");
      await diag.capture(page, "dm-editor-not-found");
      return { outcome: "failed", reason: "DM editor not found" };
    }

    let activeEditorLocator = editorMatch.locator;
    try {
      activeEditorLocator = await getActiveEditorLocator(msgCtx, editorMatch);
    } catch (err) {
      emit("warn", `Could not resolve stable editor locator: ${err.message}`);
    }
    await diag.capture(page, "editor-found");

    // ── 5a. Verify the modal's recipient matches the expected lead ──────────
    // CRITICAL DEFENSE-IN-DEPTH: even with modal-aware editor selection, we
    // re-read the recipient name directly from the active modal's header and
    // refuse to send if it does not match `leadName`. This catches any
    // regression in findBestDmEditor (e.g. a LinkedIn DOM change that
    // confuses our scoring) before a single character is typed.
    if (leadName) {
      const recipientCheck = await verifyModalRecipient(
        msgCtx,
        activeEditorLocator,
        leadName,
      ).catch((err) => ({ ok: true, warning: `verify_error: ${err.message}` }));

      if (recipientCheck && !recipientCheck.ok) {
        emit(
          "error",
          `WRONG-RECIPIENT BLOCK: ${recipientCheck.reason}`,
        );
        logger.error(
          "LinkedIn DM wrong-modal block at recipient verification",
          {
            profileUrl,
            expectedLeadName: leadName,
            actualModalRecipient: recipientCheck.actual,
          },
        );
        await diag.capture(page, "wrong-modal-recipient-block", {
          expected: leadName,
          actual: recipientCheck.actual,
        });
        // Force-clear the editor so the wrong draft is not left behind for
        // the next recipient to inherit.
        await forceClearDmDraft(page, activeEditorLocator).catch(() => {});
        return {
          outcome: "failed",
          reason: recipientCheck.reason,
        };
      }

      if (recipientCheck?.actual) {
        emit(
          "info",
          `Modal recipient verified: "${recipientCheck.actual}" matches lead "${leadName}".`,
        );
      } else if (recipientCheck?.warning) {
        emit(
          "info",
          `Modal recipient name not extractable (${recipientCheck.warning}) — relying on modal-scoped editor selection.`,
        );
      }
    }

    // ── 6. Type the message ───────────────────────────────────────────────────
    emit("info", "Typing message...");
    let typeSuccess = await typeLikeHuman(page, activeEditorLocator, message);

    // Robustness retry: if the first typing attempt failed, the editor was
    // likely replaced by a React re-render mid-typing (LinkedIn does this when
    // the modal CSS animation finishes mid-sequence). Re-find the editor from
    // scratch and try once more before giving up.
    if (!typeSuccess) {
      emit(
        "warn",
        "First typing attempt failed — re-finding editor and retrying once...",
      );
      await diag.capture(page, "type-failed-retry-1");
      await humanDelay(300, 500);

      // Re-detect context in case LinkedIn swapped modes (rare but possible
      // if the overlay finished loading after our initial detection).
      const retryCtx = await detectMessagingContext(page, 1500);
      const retryMsgCtx =
        retryCtx.mode === "iframe" && retryCtx.frame ? retryCtx.frame : msgCtx;

      const editorRetry = await waitForDmEditor(retryMsgCtx, null, 2);
      if (editorRetry) {
        let retryLocator = editorRetry.locator;
        try {
          retryLocator = await getActiveEditorLocator(retryMsgCtx, editorRetry);
        } catch (_) {}
        activeEditorLocator = retryLocator;
        // Re-bring to front in case focus was lost.
        await bringLinkedInPageToFront(
          page,
          retryCtx.mode === "iframe" ? retryCtx.frame : null,
        );
        typeSuccess = await typeLikeHuman(page, activeEditorLocator, message);
        // Keep the later Send-button lookup scoped to the same context as the
        // recovered editor. LinkedIn can finish mounting its /preload/ iframe
        // between the first attempt and this retry.
        msgCtx = retryMsgCtx;
      }
    }

    if (!typeSuccess) {
      await diag.capture(page, "type-failed");
      return {
        outcome: "failed",
        reason: "Failed to type message into editor",
      };
    }


    // ── 6a. Verify the message is actually in the DOM before clicking send ────
    const typedState = await getEditorState(activeEditorLocator);
    const typedTextNorm = normalizeEditableText(typedState.text);
    const messageNorm = normalizeEditableText(message);
    if (!typedTextNorm.includes(messageNorm)) {
      emit("error", "Typed message is not present in the active DM editor.");
      await diag.capture(page, "type-verify-failed");
      return {
        outcome: "failed",
        reason: "Typed message missing from DM editor before send",
      };
    }

    // ── 6a.1 ANTI-WRONG-RECIPIENT GUARD ──────────────────────────────────────
    // If the message we intended to send has a greeting name (e.g. "Hi Mike,"),
    // verify the editor does NOT contain a DIFFERENT greeting name. This catches
    // the case where a stale OS clipboard pasted "Hi Letrise..." into Mike's
    // composer AND the per-recipient guard in step 0a didn't fire (e.g. because
    // pageProfileName was null). It's the last line of defense before send.
    if (message) {
      const intendedGreeting = message.match(
        /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/i,
      );
      if (intendedGreeting) {
        const intendedName = intendedGreeting[1].toLowerCase();
        // Scan the editor text for any greeting addressed to a different name.
        const allGreetings = typedTextNorm.match(
          /(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\s*,?\s+([a-z]+)/gi,
        );
        if (allGreetings) {
          for (const g of allGreetings) {
            const m = g.match(/([a-z]+)$/i);
            if (m) {
              const foundName = m[1].toLowerCase();
              if (foundName !== intendedName) {
                emit(
                  "error",
                  `WRONG-RECIPIENT BLOCK: editor contains greeting to "${foundName}" ` +
                    `but intended message greets "${intendedName}". Aborting send.`,
                );
                logger.error("LinkedIn DM wrong-recipient block at post-typing", {
                  profileUrl,
                  intendedName,
                  foundInEditor: foundName,
                  editorSnippet: typedTextNorm.slice(0, 80),
                });
                await diag.capture(page, "wrong-recipient-block");
                // Force-clear the editor so the next recipient doesn't inherit
                // the wrong draft.
                await forceClearDmDraft(page, activeEditorLocator).catch(() => {});
                return {
                  outcome: "failed",
                  reason: `Editor contained greeting to "${foundName}" but intended recipient is "${intendedName}". Send aborted by post-typing guard.`,
                };
              }
            }
          }
        }
      }
    }

    // ── 6b. Short settle for React to process the input event ─────────────────
    // Performance: React processes the input event synchronously on the next
    // microtask. 400-600ms was excessive; 150-280ms is enough for the Send
    // button to flip from disabled to enabled.
    await humanDelay(150, 280);
    await diag.capture(page, "after-typing", { typedSnippet: messageSnippet(message) });

    // ── 7. Find and click the Send button ─────────────────────────────────────
    emit("info", "Looking for Send button...");

    let sendSuccessful = false;

    // Performance: poll for up to 1500ms (was 3000ms). The send button is
    // already rendered when we reach this point — we're just waiting for it
    // to flip from disabled to enabled after the input event lands.
    const SEND_BTN_POLL_TIMEOUT = 1500;
    const sendBtnPollDeadline = Date.now() + SEND_BTN_POLL_TIMEOUT;
    let sendBtnData = null;
    while (Date.now() < sendBtnPollDeadline) {
      sendBtnData = await findSendButtonForEditor(
        msgCtx,
        activeEditorLocator,
        emit,
      );
      if (sendBtnData && !sendBtnData.disabled) break;
      await humanDelay(60, 100);
    }

    if (sendBtnData && !sendBtnData.disabled) {
      emit("info", `Send button found and enabled, attempting click...`);
      await closeStrayTabs(page.context(), "linkedin").catch(() => {});
      sendSuccessful = await clickSendButtonRobust(
        page,
        sendBtnData.locator,
        activeEditorLocator,
      );
    } else {
      emit(
        "warn",
        "Send button not found or remains disabled. Falling back to Enter key.",
      );
    }
    await diag.capture(page, "send-button-search", {
      found: Boolean(sendBtnData),
      disabled: sendBtnData?.disabled,
      sendClicked: sendSuccessful,
    });

    // ── 7a. Keyboard Enter fallback ───────────────────────────────────────────
    if (!sendSuccessful) {
      emit("info", "Executing keyboard Enter fallback.");
      await closeStrayTabs(page.context(), "linkedin").catch(() => {});
      await ensureSelectionInEditor(activeEditorLocator);
      await humanDelay(80, 140);

      await page.keyboard.press("Enter").catch(() => {});
      // Performance: 600-900ms was excessive; LinkedIn clears the editor on
      // successful send within ~250ms. 300-500ms is enough to detect either
      // state.
      await humanDelay(300, 500);

      const textAfterEnter = normalizeEditableText(
        await getEditableText(activeEditorLocator).catch(() => ""),
      );
      const snippet = normalizeEditableText(message).substring(0, 20);
      sendSuccessful = !textAfterEnter.includes(snippet);

      if (!sendSuccessful) {
        await ensureSelectionInEditor(activeEditorLocator);
        await page.keyboard.press("Control+Enter").catch(() => {});
        await humanDelay(250, 400);

        const textAfterCtrlEnter = normalizeEditableText(
          await getEditableText(activeEditorLocator).catch(() => ""),
        );
        sendSuccessful = !textAfterCtrlEnter.includes(snippet);
      }
    }

    // Performance: post-send settle. 800-1200ms was excessive; verifyDmSent
    // already waits 500-800ms before checking. 350-600ms here is enough for
    // the editor to clear and any error banner to render.
    await humanDelay(350, 600);

    // ── 8. Verification — check error banner AND that editor cleared ───────────
    const verification = await verifyDmSent(page, activeEditorLocator, message);
    if (!verification.verified) {
      emit("error", `DM send failed: ${verification.reason}`);
      return { outcome: "failed", reason: verification.reason };
    }

    emit("info", `DM sent — moving to next profile.`);
    await page
      .evaluate(() => {
        window.__gtss_dm_outcome = "sent";
      })
      .catch(() => {});

    // ── 9. Navigate back to profile if we ended up on /messaging/ ─────────────
    const postSendUrl = page.url();
    if (
      postSendUrl.includes("/messaging/") ||
      postSendUrl.includes("/messages/")
    ) {
      emit("info", "Navigating back to profile after /messaging/ send...");
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      // Performance: domcontentloaded already fires when the DOM is ready.
      // 150-250ms is enough for React to mount the profile header.
      await humanDelay(150, 250);
    }

    return { outcome: "sent" };
  } catch (err) {
    logger.error("LinkedIn DM Failed", { profileUrl, error: err.message });
    emit("error", `DM failed: ${err.message}`);
    await diag.capture(page, `failure-${err.message.slice(0, 30).replace(/[^a-z0-9]/gi, '_')}`);
    return { outcome: "failed", reason: err.message };
  } finally {
    removeNoNewTabsGuard();
    await closeStrayTabs(page.context(), "linkedin").catch(() => {});
    // Flush diagnostics for this DM attempt
    diag.flush(profileUrl);
    // Clean up ALL data-gtss-* tags regardless of outcome — run in both contexts
    const cleanupAttrs = async (ctx) => {
      await ctx
        .evaluate(() => {
          const attrs = [
            "data-gtss-active-overlay",
            "data-gtss-dm-editor",
            "data-gtss-dm-overlay",
            "data-gtss-container",
            "data-gtss-send",
          ];
          for (const attr of attrs) {
            document.querySelectorAll(`[${attr}]`).forEach((el) => {
              el.removeAttribute(attr);
            });
          }
        })
        .catch(() => {});
    };
    await cleanupAttrs(page);
    if (msgCtx && msgCtx !== page) {
      await cleanupAttrs(msgCtx).catch(() => {});
    }

    // CRITICAL CONTAINMENT FIX: Purge any dirty lingering UI states before releasing control.
    const executionOutcome = await page
      .evaluate(() => window.__gtss_dm_outcome)
      .catch(() => null);

    if (executionOutcome !== "sent") {
      logger.info(
        "Outreach pipeline flag marked unsafe. Forcing interface restoration...",
      );
      await dismissAllMessagingUI(page);
    }

    // Reset the page-level outcome flag for the next run
    await page
      .evaluate(() => {
        delete window.__gtss_dm_outcome;
      })
      .catch(() => {});
  }
}

module.exports = { sendDirectMessage };

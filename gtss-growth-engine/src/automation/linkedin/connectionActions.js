/**
 * LinkedIn Connection / Follow Request
 *
 * Decision tree on a personal profile (exactly one path wins):
 *
 *   1. Pending already visible          → outcome "sent" (invite already out)
 *   2. Connect button present           → click Connect (+ modal Send if needed)
 *                                         → outcome "sent" (connection initiated)
 *   3. Follow button present            → click Follow
 *                                         → outcome "sent" (follow initiated)
 *   4. Neither Connect nor Follow       → outcome "already_connected"
 *                                         (mutual / 1st-degree — only safe assumption)
 *
 * Connect and Follow may appear alone or together. When both are present we
 * prefer Connect. Message buttons are intentionally ignored for connectivity
 * decisions — open profiles and InMail also show Message.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");
const { SELECTORS } = require("./selectors");
const {
  firstVisible,
  firstVisibleIn,
  findProfileAction,
} = require("./profileActions");
const { firstVisibleOverlay } = require("./dmEditorDetection");
const { isAnyVisibleOnProfile, detectActionWarning } = require("./detection");
const { bringLinkedInPageToFront } = require("./focus");
const { typeIntoFirstVisibleIn } = require("./typing");

/**
 * Exact-word match for action labels.
 * "follow" must NOT match "following"; "connect" must NOT match "connected".
 */
function exactActionWord(text, word) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized === word) return true;
  // e.g. "Invite X to connect", "Follow Name"
  const re = new RegExp(`(?:^|\\b)${word}(?:\\b|$)`, "i");
  if (!re.test(normalized)) return false;
  // Reject past/progress forms that contain the root word.
  if (word === "follow" && /\bfollowing\b/.test(normalized)) return false;
  if (word === "connect" && /\bconnected\b/.test(normalized)) return false;
  return true;
}

/**
 * Single-pass scan of the profile top-card action area.
 * Returns which primary CTAs are actually available right now.
 *
 * @returns {Promise<{
 *   pending: boolean,
 *   following: boolean,
 *   connect: { selector: string } | null,
 *   follow: { selector: string } | null,
 *   connectInMore: boolean,
 *   followInMore: boolean,
 * }>}
 */
async function scanProfileCtas(page) {
  const token = `gtss-cta-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const raw = await page
    .evaluate((marker) => {
      const viewportWidth = window.innerWidth || 1366;
      const viewportHeight = window.innerHeight || 768;
      const maxX = Math.max(760, viewportWidth * 0.75);
      const maxY = Math.max(820, viewportHeight * 0.92);

      const normalize = (v) =>
        String(v || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          rect.x >= 0 &&
          rect.x <= maxX &&
          rect.y >= 50 &&
          rect.y <= maxY &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0" &&
          !el.disabled &&
          el.getAttribute("aria-disabled") !== "true"
        );
      };

      const inTopCard = (el) =>
        Boolean(
          el.closest(
            ".pv-top-card, .ph5.pb5, section:has(h1), [data-view-name*='profile-card'], main section",
          ),
        );

      const exactWord = (text, word) => {
        const n = normalize(text);
        if (!n) return false;
        if (n === word) return true;
        const re = new RegExp(`(?:^|\\b)${word}(?:\\b|$)`, "i");
        if (!re.test(n)) return false;
        if (word === "follow" && /\bfollowing\b/.test(n)) return false;
        if (word === "connect" && /\bconnected\b/.test(n)) return false;
        return true;
      };

      const labelOf = (el) =>
        [
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("data-control-name"),
          el.textContent,
        ]
          .filter(Boolean)
          .join(" ");

      // Prefer buttons/links inside the main profile header area.
      const nodes = Array.from(
        document.querySelectorAll(
          "main button, main a[role='button'], main .artdeco-button, main [role='button']",
        ),
      ).filter((el) => isVisible(el) && inTopCard(el));

      let pending = false;
      let following = false;
      let connectEl = null;
      let followEl = null;
      let moreEl = null;

      for (const el of nodes) {
        const label = labelOf(el);
        const n = normalize(label);

        if (exactWord(label, "pending") || n === "pending") {
          pending = true;
          continue;
        }
        if (/\bfollowing\b/.test(n) && !exactWord(label, "follow")) {
          following = true;
          continue;
        }
        if (
          exactWord(label, "connect") ||
          (n.includes("invite") && n.includes("connect"))
        ) {
          if (!connectEl) connectEl = el;
          continue;
        }
        if (exactWord(label, "follow")) {
          if (!followEl) followEl = el;
          continue;
        }
        // Profile "More actions" only — never the global nav "More".
        if (
          n === "more" ||
          n === "more actions" ||
          n.includes("more actions") ||
          el.getAttribute("aria-label") === "More actions"
        ) {
          if (!moreEl) moreEl = el;
        }
      }

      const mark = (el, kind) => {
        if (!el) return null;
        const attr = `${marker}-${kind}`;
        el.setAttribute("data-gtss-cta", attr);
        return {
          selector: `[data-gtss-cta="${attr}"]`,
          label: normalize(labelOf(el)),
        };
      };

      return {
        pending,
        following,
        connect: mark(connectEl, "connect"),
        follow: mark(followEl, "follow"),
        more: mark(moreEl, "more"),
      };
    }, token)
    .catch(() => null);

  if (!raw) {
    return {
      pending: false,
      following: false,
      connect: null,
      follow: null,
      more: null,
    };
  }

  const toMatch = async (info) => {
    if (!info?.selector) return null;
    const locator = page.locator(info.selector).first();
    if (!(await locator.isVisible({ timeout: 200 }).catch(() => false))) {
      return null;
    }
    return { locator, selector: `scan:${info.label || info.selector}` };
  };

  return {
    pending: Boolean(raw.pending),
    following: Boolean(raw.following),
    connect: await toMatch(raw.connect),
    follow: await toMatch(raw.follow),
    more: await toMatch(raw.more),
  };
}

/**
 * Dismiss an open profile More / dropdown menu so main CTAs stay clickable.
 */
async function dismissOpenMenus(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(120, 220);
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(80, 160);
}

/**
 * Open the profile More menu and look for Connect or Follow inside it.
 * Closes the menu if the action is not found so the main CTAs remain usable.
 */
async function findActionInMoreMenu(page, action /* 'connect' | 'follow' */, emit) {
  const selectors =
    action === "connect" ? SELECTORS.connect : SELECTORS.follow;
  const actionName = action === "connect" ? "Connect" : "Follow";

  const moreMatch =
    (await scanProfileCtas(page)).more ||
    (await findProfileAction(page, SELECTORS.more, "More", 800));
  if (!moreMatch) return null;

  emit("info", `Opening More menu to look for ${actionName}…`);
  await moreMatch.locator.evaluate((el) => el.click()).catch(async () => {
    await moreMatch.locator.click({ force: true }).catch(() => {});
  });
  await humanDelay(700, 1400);

  // Prefer items inside the open dropdown; fall back to any newly visible CTA.
  const fromOverlay = await firstVisibleOverlay(
    page,
    SELECTORS.actionDropdown,
    selectors,
    2500,
  );
  if (fromOverlay) {
    if (action === "follow") {
      const text = await fromOverlay.locator.innerText().catch(() => "");
      const aria = await fromOverlay.locator
        .getAttribute("aria-label")
        .catch(() => "");
      if (
        exactActionWord(text, "follow") ||
        exactActionWord(aria, "follow")
      ) {
        return fromOverlay;
      }
    } else {
      return fromOverlay;
    }
  }

  const pageLevel = await firstVisible(page, selectors, 1200);
  if (pageLevel) return pageLevel;

  // Action not in More — close the menu so Follow/Connect on the card stay free.
  emit("info", `${actionName} not in More menu — dismissing menu.`);
  await dismissOpenMenus(page);
  return null;
}

/**
 * Click an element via DOM click, with force-click fallback.
 */
async function clickCta(match) {
  await match.locator.evaluate((el) => el.click()).catch(async () => {
    await match.locator.click({ force: true }).catch(() => {});
  });
}

/**
 * After Connect is clicked, complete the invite modal if LinkedIn shows one.
 * We assume the connection was initiated once Send succeeds, Pending appears,
 * or the Connect control is gone.
 */
async function completeConnectModal(page, message, emit) {
  if (message) {
    const modalMatch = await firstVisible(page, SELECTORS.modal, 3000);
    const addNoteMatch = modalMatch
      ? await firstVisibleIn(modalMatch.locator, SELECTORS.addNote, 2000)
      : null;
    if (addNoteMatch) {
      emit("info", "Adding connection note...");
      await addNoteMatch.locator.click();
      await humanDelay(500, 900);

      const noteModalMatch = await firstVisible(page, SELECTORS.modal, 3000);
      if (!noteModalMatch) {
        throw new Error("Connection note modal not visible");
      }
      await typeIntoFirstVisibleIn(
        page,
        noteModalMatch.locator,
        SELECTORS.noteTextarea,
        message,
      );
      await humanDelay(500, 900);
    } else {
      emit(
        "warn",
        "Add-note option not found. This request may send without a note.",
      );
    }
  }

  // One-click / auto-pending paths (no Send modal).
  if (await isAnyVisibleOnProfile(page, SELECTORS.pending)) {
    emit("info", "Connection request moved to pending.");
    return { outcome: "sent", reason: "Connection request initiated" };
  }

  const sendMatch = await firstVisibleOverlay(
    page,
    SELECTORS.modal,
    SELECTORS.modalSend,
    3000,
  );
  if (
    sendMatch &&
    !(await sendMatch.locator.isDisabled().catch(() => false))
  ) {
    emit("info", `Clicking Send (${sendMatch.selector})...`);
    await sendMatch.locator.click();
    await humanDelay(700, 1400);

    const warning = await detectActionWarning(page);
    if (warning) {
      emit("error", `LinkedIn warning after Connect: ${warning}`);
      return { outcome: "failed", reason: `LinkedIn warning: ${warning}` };
    }

    emit("info", "Connection request submitted.");
    return { outcome: "sent", reason: "Connection request initiated" };
  }

  const isEmailRequired = await page
    .locator('input[type="email"]')
    .isVisible()
    .catch(() => false);
  if (isEmailRequired) {
    emit("error", "LinkedIn requires an email to connect with this user.");
    return { outcome: "failed", reason: "Email required" };
  }

  if (await isAnyVisibleOnProfile(page, SELECTORS.pending)) {
    emit("info", "Connection request pending after Connect click.");
    return { outcome: "sent", reason: "Connection request initiated" };
  }

  // Connect control gone after click → treat as initiated.
  const after = await scanProfileCtas(page);
  if (!after.connect) {
    emit("info", "Connect control gone after click — treating as initiated.");
    return { outcome: "sent", reason: "Connection request initiated" };
  }

  emit("error", 'Could not find "Send" button after Connect.');
  return { outcome: "failed", reason: "Send button not found" };
}

/**
 * Click Follow and assume follow was initiated (user-confirmed decision model).
 */
async function clickFollow(page, followMatch, emit) {
  emit("info", `Clicking Follow (${followMatch.selector})...`);
  await clickCta(followMatch);
  await humanDelay(800, 1500);

  const warning = await detectActionWarning(page);
  if (warning) {
    emit("error", `LinkedIn warning after Follow: ${warning}`);
    return { outcome: "failed", reason: `LinkedIn warning: ${warning}` };
  }

  // Assumption: follow was sent once we clicked a real Follow CTA.
  // Confirming signals (Following / Pending / Follow gone) are logged only.
  const after = await scanProfileCtas(page);
  if (after.following || after.pending || !after.follow) {
    emit("info", "Follow initiated.");
  } else {
    emit(
      "info",
      "Follow clicked — treating as initiated (Follow still visible may be UI lag).",
    );
  }
  return { outcome: "sent", reason: "Follow initiated" };
}

/**
 * Perform a LinkedIn connection or follow with the strict decision tree above.
 */
async function sendConnectionRequest(page, profileUrl, message, emit) {
  try {
    await bringLinkedInPageToFront(page);
    emit("info", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(400, 800);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(250, 500);

    emit(
      "info",
      "Profile loaded. Decision: Connect if present → else Follow if present → else mutual connection.",
    );

    // ── Step 1: scan visible CTAs ──────────────────────────────────────────
    let ctas = await scanProfileCtas(page);

    // ── Step 1b: already pending invite ────────────────────────────────────
    if (ctas.pending) {
      emit("info", "Pending already visible — connection/follow already initiated.");
      return {
        outcome: "sent",
        reason: "Connection request already pending",
      };
    }

    // Already following with no Connect → treat as handled (follow already out).
    // Do NOT call this "mutual connection"; mutual is only when neither CTA exists.
    // If Connect is still available, prefer Connect below.

    // ── Step 2: Connect present → click Connect ────────────────────────────
    // Prefer visible Connect. If missing, check More (common when Follow is primary).
    let connectMatch = ctas.connect;
    if (!connectMatch) {
      connectMatch = await findActionInMoreMenu(page, "connect", emit);
    }

    if (connectMatch) {
      emit(
        "info",
        `Connect found — clicking Connect (${connectMatch.selector}).`,
      );
      await clickCta(connectMatch);
      await humanDelay(700, 1200);
      return completeConnectModal(page, message, emit);
    }

    // ── Step 3: Follow present → click Follow ──────────────────────────────
    // Re-scan after any More-menu open/close so we see the live Follow CTA.
    ctas = await scanProfileCtas(page);
    let followMatch = ctas.follow;
    if (!followMatch) {
      followMatch = await findActionInMoreMenu(page, "follow", emit);
    }

    if (followMatch) {
      return clickFollow(page, followMatch, emit);
    }

    // ── Step 4: neither Connect nor Follow → mutual connection ─────────────
    // ONLY safe assumption that this is already a mutual / 1st-degree connection.
    // Message is ignored on purpose (open profiles / InMail also show Message).
    emit(
      "info",
      "Neither Connect nor Follow found — assuming mutual connection.",
    );
    return {
      outcome: "already_connected",
      reason: "No Connect or Follow button — mutual connection",
    };
  } catch (err) {
    logger.error("LinkedIn Connection Request Failed", {
      profileUrl,
      error: err.message,
    });
    emit("error", `Connection failed: ${err.message}`);
    return { outcome: "failed", reason: err.message };
  }
}

module.exports = {
  sendConnectionRequest,
  // Exported for unit tests / diagnostics
  scanProfileCtas,
  exactActionWord,
};

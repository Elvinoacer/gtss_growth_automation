/**
 * LinkedIn Profile Actions
 * Helpers for locating visible elements on a LinkedIn profile page — buttons,
 * action links, the profile header, and the "Message" action specifically.
 * Extracted from the original linkedin.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const { SELECTORS } = require("./selectors");

async function firstVisible(page, selectors, timeout = 1500) {
  return firstVisibleIn(page, selectors, timeout);
}

async function firstVisibleIn(scope, selectors, timeout = 1500) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      // Find the first element matching this selector that is currently visible
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        const isVisible = await candidate
          .isVisible({ timeout: 50 })
          .catch(() => false);
        if (isVisible) {
          return {
            locator: candidate,
            selector: count > 1 ? `${selector} >> nth=${index}` : selector,
          };
        }
      }
    }
    // Briefly pause before polling all selectors again
    await humanDelay(100, 150);
  }

  return null;
}

async function getProfileHeader(page) {
  for (const selector of SELECTORS.profileHeader) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 3000 });
      const hasProfileName = await locator
        .locator("h1, .text-heading-xlarge")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!hasProfileName) continue;
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

  const mainAreaMatch = await firstVisibleInMainProfileArea(
    page,
    selectors,
    timeout,
  );

  if (mainAreaMatch) return mainAreaMatch;

  return null;
}

async function firstVisibleInMainProfileArea(page, selectors, timeout = 1500) {
  const viewport =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      .catch(() => ({ width: 1366, height: 768 })));
  const maxX = Math.max(700, viewport.width * 0.68);
  const maxY = Math.max(700, viewport.height * 0.9);

  for (const selector of selectors) {
    const locator = page.locator(`main ${selector}`);
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      try {
        await candidate.waitFor({ state: "visible", timeout });
        const box = await candidate.boundingBox();
        if (!box) continue;

        const isMainProfileAction =
          box.x >= 0 && box.x < maxX && box.y >= 80 && box.y < maxY;

        if (isMainProfileAction) {
          return {
            locator: candidate,
            selector: `main ${selector} [main-profile-area #${i}]`,
          };
        }
      } catch (_) {
        // Try the next matching element.
      }
    }
  }

  return null;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function quickVisibleProfileAction(page, action, timeout = 900) {
  const actionText = normalizeText(action);
  const token = `gtss-${actionText}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page
      .evaluate(
        ({ actionText, token }) => {
          const viewportWidth = window.innerWidth || 1366;
          const viewportHeight = window.innerHeight || 768;
          const maxX = Math.max(760, viewportWidth * 0.72);
          const maxY = Math.max(820, viewportHeight * 0.92);
          const actionSelectors = [
            "main .pv-top-card button",
            "main .pv-top-card a",
            "main section button",
            "main section a",
          ];
          const seen = new Set();
          const candidates = [];

          for (const selector of actionSelectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (seen.has(el)) continue;
              seen.add(el);

              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (
                rect.width < 8 ||
                rect.height < 8 ||
                rect.x < 0 ||
                rect.x > maxX ||
                rect.y < 55 ||
                rect.y > maxY ||
                style.visibility === "hidden" ||
                style.display === "none" ||
                el.disabled ||
                el.getAttribute("aria-disabled") === "true"
              ) {
                continue;
              }

              const label = [
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("data-control-name"),
              ]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
              const visibleText = String(el.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
              const href = String(el.getAttribute("href") || "").toLowerCase();
              const dataControl = String(
                el.getAttribute("data-control-name") || "",
              ).toLowerCase();
              const exactVisibleText = visibleText === actionText;
              const exactAriaOrTitle =
                label === actionText ||
                label.startsWith(`${actionText} `) ||
                label.includes(` ${actionText} `);
              const isMessageLink =
                actionText === "message" &&
                (href.includes("/messaging/compose") ||
                  href.includes("/messaging/thread") ||
                  dataControl === "message");

              if (
                !exactVisibleText &&
                !exactAriaOrTitle &&
                !isMessageLink
              ) {
                continue;
              }

              // A page can contain other visible "Message" controls (the
              // persistent inbox, suggested people, or an old chat bubble).
              // Only the action in the profile's own top card is eligible.
              // The slower header-scoped fallback below covers older layouts
              // that do not use one of these containers.
              const topCard = el.closest(
                ".pv-top-card, .ph5.pb5, section:has(h1), [data-view-name*='profile-card']",
              );
              if (!topCard) continue;
              candidates.push({
                el,
                score: 100 - rect.y / 10 - rect.x / 100,
              });
            }
          }

          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0]?.el;
          if (!best) return null;
          best.setAttribute("data-gtss-profile-action", token);
          return {
            selector: `[data-gtss-profile-action="${token}"]`,
            label: (
              best.getAttribute("aria-label") ||
              best.textContent ||
              best.href ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          };
        },
        { actionText, token },
      )
      .catch(() => null);

    if (result?.selector) {
      const locator = page.locator(result.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `quick:${actionText}:${result.label || result.selector}`,
        };
      }
    }

    await humanDelay(80, 140);
  }

  return null;
}

async function findProfileAction(page, selectors, actionName, timeout = 1200) {
  const quick = await quickVisibleProfileAction(
    page,
    actionName,
    Math.min(timeout, 900),
  );
  if (quick) return quick;
  return firstVisibleOnProfile(page, selectors, timeout);
}

async function findProfileMessageAction(page, timeout = 2200) {
  const direct = await findProfileAction(
    page,
    SELECTORS.message,
    "Message",
    Math.min(timeout, 2000),
  );
  if (direct) return direct;

  const moreMatch = await findProfileAction(page, SELECTORS.more, "More", 700);
  if (!moreMatch) return null;

  // Use DOM-level click to bypass LinkedIn's sticky header intercept trap.
  // coordinate-based click({ force: true }) hits the fixed nav bar when the
  // element scrolls to y≈0, firing the "Hire with AI" link in a new tab.
  await moreMatch.locator.evaluate((el) => el.click()).catch(() => {});
  await humanDelay(180, 320);

  // NOTE: circular require — loaded lazily so CommonJS returns the partial
  // module on first load, and the function resolves correctly at call time.
  const { firstVisibleOverlay } = require("./dmEditorDetection");
  const fromMenu = await firstVisibleOverlay(
    page,
    SELECTORS.actionDropdown,
    SELECTORS.message,
    Math.max(700, timeout - 700),
  );

  if (fromMenu) {
    return {
      ...fromMenu,
      selector: `More menu >> ${fromMenu.selector}`,
    };
  }

  return null;
}

module.exports = {
  firstVisible,
  firstVisibleIn,
  getProfileHeader,
  firstVisibleOnProfile,
  firstVisibleInMainProfileArea,
  normalizeText,
  quickVisibleProfileAction,
  findProfileAction,
  findProfileMessageAction,
};

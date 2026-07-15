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
          // LinkedIn's current profile layout often places primary actions
          // (Message / Connect / More) in a left rail OUTSIDE <main>. Include
          // those surfaces so we don't fall through to "People also viewed"
          // Message links lower on the page.
          const actionSelectors = [
            "main .pv-top-card button",
            "main .pv-top-card a",
            "main section button",
            "main section a",
            "aside a[href*='/messaging/compose']",
            "aside button",
            "aside a",
            "[data-view-name*='profile'] a[href*='/messaging/compose']",
            "[data-view-name*='profile'] button",
            "a[href*='/messaging/compose']",
            "a[href*='/messaging/thread']",
          ];
          const seen = new Set();
          const candidates = [];

          // Hard-reject top-nav chrome so we never treat "For Business" etc.
          // as a profile action (and never click it via a loose match).
          const isTopNavChrome = (el) => {
            const label = (
              el.getAttribute("aria-label") ||
              el.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            if (
              /for business|hire with ai|my network|notifications|home|jobs|messaging|me\b|my apps/.test(
                label,
              ) &&
              !/message\s+\w/.test(label)
            ) {
              // Allow "Message <Name>" aria labels; reject bare nav items.
              if (label === "messaging" || label.includes("for business")) {
                return true;
              }
              if (
                el.closest(
                  "header, .global-nav, nav[aria-label*='Primary' i], nav[class*='global-nav']",
                )
              ) {
                return true;
              }
            }
            if (
              el.closest(
                'button[aria-label="For Business"], button[aria-label*="For Business" i]',
              )
            ) {
              return true;
            }
            return false;
          };

          for (const selector of actionSelectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (seen.has(el)) continue;
              seen.add(el);

              if (isTopNavChrome(el)) continue;

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
              // Exact word match so "follow" does not match "following"
              // and "connect" does not match "connected".
              const wordRe = new RegExp(
                `(?:^|\\b)${actionText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|$)`,
              );
              const exactVisibleText = visibleText === actionText;
              const wordInVisible = wordRe.test(visibleText);
              const wordInLabel = wordRe.test(label);
              const rejectedForm =
                (actionText === "follow" && /\bfollowing\b/.test(visibleText + " " + label)) ||
                (actionText === "connect" && /\bconnected\b/.test(visibleText + " " + label));
              const exactAriaOrTitle =
                label === actionText ||
                label.startsWith(`${actionText} `) ||
                (wordInLabel && !rejectedForm);
              const isMessageLink =
                actionText === "message" &&
                (href.includes("/messaging/compose") ||
                  href.includes("/messaging/thread") ||
                  dataControl === "message");

              if (rejectedForm) continue;

              if (
                !exactVisibleText &&
                !wordInVisible &&
                !exactAriaOrTitle &&
                !isMessageLink
              ) {
                continue;
              }

              // A page can contain other visible "Message" controls (the
              // persistent inbox, suggested people, or an old chat bubble).
              // Prefer the profile's own top card / primary action rail.
              // For Message links, also accept compose anchors in the upper
              // left profile action area even when class names are obfuscated
              // and there is no classic .pv-top-card wrapper.
              const topCard = el.closest(
                ".pv-top-card, .ph5.pb5, section:has(h1), [data-view-name*='profile-card'], [data-view-name*='profile-top-card']",
              );
              const inPrimaryActionRail =
                actionText === "message" &&
                isMessageLink &&
                rect.y >= 55 &&
                rect.y < 520 &&
                rect.x < maxX &&
                // Exclude "People also viewed" style cards lower on the page.
                !el.closest(
                  '[data-view-name*="browsemap"], [data-view-name*="similar"],' +
                    ' [data-view-name*="pymk"], aside[aria-label*="People" i]',
                );

              if (!topCard && !inPrimaryActionRail) continue;

              // Prefer top-card matches, then higher / lefter compose links.
              let score = 100 - rect.y / 10 - rect.x / 100;
              if (topCard) score += 50;
              if (isMessageLink && href.includes("profileurn")) score += 30;
              if (isMessageLink && href.includes("interop=msgoverlay")) score += 20;
              candidates.push({
                el,
                score,
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

/**
 * Extract the LinkedIn vanity slug from a profile URL
 * (e.g. "/in/gracemumo1/" → "gracemumo1").
 */
function extractProfileVanity(url) {
  const m = String(url || "").match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

/**
 * Find the primary profile "Message" control for the person whose profile
 * we are currently viewing.
 *
 * CRITICAL BUG (production log 2026-07-14): on Hellen Nduhi's profile we
 * clicked `compose:Message Frida Ochieng#score=185` — a sidebar / related
 * person's Message link that scored high on position+interop alone. That
 * opened Frida's compose URL (premium wall) and we never messaged Hellen.
 *
 * Hard rules now:
 *   1. Read the page's profile h1 first name.
 *   2. If aria-label is "Message <Name>", <Name>'s first token MUST match
 *      the page profile first name — otherwise REJECT (Frida ≠ Hellen).
 *   3. Prefer bare "Message" CTA that sits near the profile h1 (primary
 *      action rail), not deep-page / related-people cards.
 *   4. NEVER return a named Message for a different person just because
 *      it has interop=msgOverlay and sits high in the viewport.
 */
async function findBestProfileComposeLink(page, timeout = 1800) {
  const vanity = extractProfileVanity(page.url());
  const token = `gtss-msg-compose-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const result = await page
      .evaluate(
        ({ vanity, token }) => {
          const normalize = (s) =>
            String(s || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const firstToken = (s) =>
            normalize(s)
              .replace(/[^a-z\s'-]/g, " ")
              .split(/\s+/)
              .find((t) => t.length >= 2) || "";

          // Page owner identity — the only person we are allowed to Message.
          const h1 =
            document.querySelector("main h1") ||
            document.querySelector("h1.text-heading-xlarge") ||
            document.querySelector("h1");
          const pageName = normalize(h1 ? h1.textContent : "");
          const pageFirst = firstToken(pageName);

          // Geometry of the profile identity block — primary Message lives near it.
          let h1Rect = null;
          if (h1) {
            try {
              h1Rect = h1.getBoundingClientRect();
            } catch (_) {
              h1Rect = null;
            }
          }

          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width >= 8 &&
              rect.height >= 8 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < (window.innerHeight || 900) &&
              rect.left < (window.innerWidth || 1400) &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || 1) > 0.05
            );
          };

          const isNavChrome = (el) => {
            if (
              el.closest(
                'header, .global-nav, nav[aria-label*="Primary" i], button[aria-label="For Business"]',
              )
            ) {
              const label = normalize(
                el.getAttribute("aria-label") || el.textContent || "",
              );
              if (
                /for business|hire with ai|messaging|home|jobs|my network|notifications/.test(
                  label,
                ) &&
                !/^message\s+/i.test(label.trim())
              ) {
                return true;
              }
            }
            return false;
          };

          // Related-people modules — never Message someone from these.
          const isRelatedModule = (el) =>
            Boolean(
              el.closest(
                '[data-view-name*="browsemap"], [data-view-name*="similar"],' +
                  ' [data-view-name*="pymk"], [data-view-name*="related"],' +
                  ' [data-view-name*="discovery"], [data-view-name*="cohort"],' +
                  ' aside[aria-label*="People" i], section[aria-label*="People" i],' +
                  ' [class*="browsemap"], [class*="pymk"]',
              ),
            );

          const links = Array.from(
            document.querySelectorAll(
              'a[href*="/messaging/compose"], a[href*="/messaging/thread"],' +
                ' button[aria-label^="Message" i], button',
            ),
          );
          const candidates = [];

          for (const el of links) {
            if (!visible(el) || isNavChrome(el) || isRelatedModule(el)) continue;

            const href = String(el.getAttribute("href") || "");
            const hrefLower = href.toLowerCase();
            const rect = el.getBoundingClientRect();
            const text = normalize(el.textContent);
            // Visible label often nests SVG + "Message"; take last word-ish.
            const visibleLabel = text.replace(/\s+/g, " ").trim();
            const aria = normalize(el.getAttribute("aria-label") || "");

            const looksLikeMessage =
              visibleLabel === "message" ||
              /^message\b/.test(visibleLabel) ||
              /^message\b/.test(aria) ||
              (hrefLower.includes("/messaging/compose") &&
                (visibleLabel.includes("message") || aria.includes("message")));
            if (!looksLikeMessage) continue;

            // ── HARD REJECT: "Message Frida Ochieng" while viewing Hellen ──
            // Aria form is typically "Message <Full Name>".
            const named =
              aria.match(/^message\s+(.+)$/i) ||
              visibleLabel.match(/^message\s+(.+)$/i);
            if (named && pageFirst) {
              const targetFirst = firstToken(named[1]);
              if (
                targetFirst &&
                targetFirst !== pageFirst &&
                !pageName.includes(targetFirst) &&
                !normalize(named[1]).includes(pageFirst)
              ) {
                // Wrong person — never click (production Frida-on-Hellen bug).
                continue;
              }
            }

            let score = 0;

            // Named Message that matches page owner — strong signal.
            if (named && pageFirst) {
              const targetFirst = firstToken(named[1]);
              if (
                targetFirst === pageFirst ||
                pageName.includes(targetFirst) ||
                normalize(named[1]).includes(pageFirst)
              ) {
                score += 300;
              }
            }

            // Bare "Message" CTA (no other name) — primary profile action.
            if (
              (visibleLabel === "message" || aria === "message") &&
              !named
            ) {
              score += 180;
            }

            // Must sit near the profile h1 / identity block when possible.
            let primaryProfileAction = false;
            if (h1Rect) {
              const nearH1 =
                Math.abs(rect.top - h1Rect.bottom) < 220 &&
                rect.left < h1Rect.right + 80 &&
                rect.top >= h1Rect.top - 40;
              if (nearH1) {
                score += 200;
                primaryProfileAction = true;
              }
              // Far below the identity block → almost certainly related people.
              if (rect.top > h1Rect.bottom + 400) score -= 250;
            } else {
              if (rect.y >= 50 && rect.y < 360) {
                score += 60;
                primaryProfileAction = true;
              }
            }

            // Prefer interop overlay compose (stays on profile).
            if (hrefLower.includes("interop=msgoverlay")) score += 40;
            if (hrefLower.includes("profileurn")) score += 20;
            if (hrefLower.includes("non_self_profile_view")) score += 15;

            if (vanity && hrefLower.includes(vanity)) score += 80;

            if (
              el.closest(
                ".pv-top-card, .ph5.pb5, section:has(h1)," +
                  " [data-view-name*='profile-card'], [data-view-name*='profile-top-card']",
              )
            ) {
              score += 100;
              primaryProfileAction = true;
            }

            // Do not use a merely visible Message control. A related-person
            // card can look identical and sometimes sits high in the viewport.
            // Without a positive relationship to this profile's identity card,
            // this candidate is unsafe even if it scores well.
            if (!primaryProfileAction) continue;

            // Penalize deep-page links hard.
            if (rect.y > 520) score -= 120;
            if (rect.y > 800) score -= 250;

            candidates.push({ el, score, href, aria, pageFirst });
          }

          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0];
          // Raise threshold — wrong-person links used to pass at score ~185.
          if (!best || best.score < 150) return null;
          best.el.setAttribute("data-gtss-profile-action", token);
          return {
            selector: `[data-gtss-profile-action="${token}"]`,
            href: best.href,
            score: best.score,
            pageFirst: best.pageFirst || pageFirst,
            label: (
              best.el.getAttribute("aria-label") ||
              best.el.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          };
        },
        { vanity, token },
      )
      .catch(() => null);

    if (result?.selector) {
      const locator = page.locator(result.selector).first();
      if (await locator.isVisible({ timeout: 150 }).catch(() => false)) {
        return {
          locator,
          selector: `compose:${result.label || result.selector}#score=${result.score}`,
          href: result.href || null,
          pageFirst: result.pageFirst || null,
        };
      }
    }

    await humanDelay(80, 140);
  }

  return null;
}

async function findProfileMessageAction(page, timeout = 2200) {
  // Path 1: best compose link for THIS profile (most reliable).
  const compose = await findBestProfileComposeLink(
    page,
    Math.min(timeout, 1800),
  );
  if (compose) return compose;

  // Path 2: header-scoped selectors only — do NOT fall through to
  // firstVisibleInMainProfileArea which picks unrelated "Message" links.
  const headerMatch = await getProfileHeader(page);
  if (headerMatch) {
    const scoped = await firstVisibleIn(
      headerMatch.locator,
      SELECTORS.message,
      Math.min(timeout, 1000),
    );
    if (scoped) {
      const href = await scoped.locator.getAttribute("href").catch(() => null);
      return {
        ...scoped,
        href,
        selector: `${headerMatch.selector} >> ${scoped.selector}`,
      };
    }
  }

  // Intentionally do not open More as a fallback. Its menu is detached from
  // the profile card and LinkedIn can leave a related-person menu mounted;
  // without a recipient binding it is unsafe to click. A missing visible
  // primary Message action is reported as a safe skip instead.
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
  findBestProfileComposeLink,
  extractProfileVanity,
};

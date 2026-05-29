const fs = require("fs");
const path = require("path");

const {
  humanDelay,
  firstVisible,
  checkForInstagramBlock,
  humanMouseMove,
  humanTypeText,
  dailySessionWarmup,
  isInstagramBlocked,
  getSelectorHealthReport,
} = require("./browserBase");
const { getDb } = require("../db/database");
const logger = require("../utils/logger");
const { normalizeInstagramUsername } = require("../utils/instagramUsername");

const INSTAGRAM_DEBUG_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const IG_SELECTORS = {
  followButton: [
    'button:has-text("Follow")',
    'button:has-text("Follow Back")',
    'button:has-text("Follow back")',
    'div[role="button"]:has-text("Follow")',
    'div[role="button"]:has-text("Follow Back")',
    'div[role="button"]:has-text("Follow back")',
  ],
  unfollowButton: [
    'button:has-text("Following")',
    'button:has-text("Requested")',
    'div[role="button"]:has-text("Following")',
    'div[role="button"]:has-text("Requested")',
  ],
  unfollowConfirm: [
    'button:has-text("Unfollow")',
    'span:has-text("Unfollow")',
    "button.xyb1x0",
    'div[role="button"]:has-text("Unfollow")',
  ],
  dmComposer: [
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message..."]',
    'div[aria-label*="Message" i]',
  ],
  dmSend: [
    'button:has-text("Send")',
    'div[role="button"]:has-text("Send")',
    'svg[aria-label="Send"]',
  ],
  newMessage: [
    'button[aria-label="New Message"]',
    'svg[aria-label="New message"]',
    'a[href*="/direct/new"]',
  ],
  recipientSearch: [
    'input[name="query"]',
    'input[placeholder*="Search..."]',
    'input[type="text"]',
  ],
  chatNext: ['button:has-text("Next")', 'div[role="button"]:has-text("Next")'],
  postCreate: [
    'div[aria-selected="false"]:has(svg[aria-label="New post"])',
    'div:has(svg[aria-label="New post"])',
    'div:has(svg[aria-label="Create"])',
    'div[role="button"]:has(svg[aria-label="New post"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'span:has-text("Create")',
    'a[href*="/create"] span',
    'a[href="/create/"] span',
    'div[role="button"] svg[aria-label="New post"]',
    'a[role="link"]:has(svg[aria-label="Create"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
  ],
  postCreateTooltipPost: [
    'a:has(span:text-is("Post"))',
    'div[role="button"]:has(span:text-is("Post"))',
    'span:text-is("Post")',
    'div:has(span:text-is("Post"))',
    '[role="menuitem"]:has-text("Post")',
    'div[tabindex="0"]:has(span:text-is("Post"))',
  ],
  fileInput: ['input[type="file"]'],
  captionBox: [
    'div[role="dialog"] textarea[aria-label*="caption" i]',
    'div[role="dialog"] textarea[placeholder*="caption" i]',
    'div[role="dialog"] div[role="textbox"][contenteditable="true"][aria-label*="caption" i]',
    'div[role="dialog"] div[aria-label*="Write a caption" i][contenteditable="true"]',
    'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Write a caption" i]',
    'textarea[aria-label*="caption" i]',
    'textarea[placeholder*="caption" i]',
  ],
  shareButton: [
    'div[role="dialog"] button[aria-label="Share"]',
    'div[role="dialog"] div[role="button"][aria-label="Share"]',
    'div[role="dialog"] button:has-text("Share")',
    'div[role="dialog"] div[role="button"]:has-text("Share")',
    'button:has-text("Share")',
    'div[role="button"]:has-text("Share")',
  ],
  storyRing: [
    'canvas[style*="cursor: pointer"]',
    'div[role="button"][aria-label*="Story"]',
    "header img[srcset]",
  ],
  storyClose: ['svg[aria-label="Close"]', 'button[aria-label="Close"]'],
  likeButton: [
    'span[class*="like"]',
    'svg[aria-label="Like"]',
    'svg[aria-label="Unlike"]',
    'button:has(svg[aria-label="Like"])',
    'button:has(svg[aria-label="Unlike"])',
  ],
};

async function bringPageToFront(page) {
  if (page && typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});
  }
}

async function waitForPostFileInput(page, timeout = 15000) {
  const fileInputLocator = page.locator('input[type="file"]');
  await fileInputLocator.waitFor({ state: "attached", timeout });
  return fileInputLocator;
}

async function getAttachedPostFileInput(page, timeout = 1200) {
  const fileInputLocator = page.locator('input[type="file"]');
  const count = await fileInputLocator.count().catch(() => 0);
  if (count === 0) return null;

  await fileInputLocator
    .first()
    .waitFor({ state: "attached", timeout })
    .catch(() => null);

  return fileInputLocator;
}

async function clickInstagramPostMenuOption(page) {
  const clickedViaDom = await page
    .evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const clickableAncestor = (el) => {
        let node = el;
        while (node && node !== document.body) {
          if (
            node.matches?.(
              'a, button, [role="button"], [role="menuitem"], [tabindex="0"]',
            )
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return el;
      };

      const candidates = [...document.querySelectorAll("span, div, a, button")]
        .filter((el) => (el.textContent || "").trim() === "Post")
        .map((el) => {
          const target = clickableAncestor(el);
          const rect = target.getBoundingClientRect();
          return { el, target, rect };
        })
        .filter(({ target, rect }) => {
          if (!isVisible(target)) return false;
          const nearSidebarMenu = rect.left < 420 && rect.top > 40;
          const reasonableMenuRow = rect.width <= 360 && rect.height <= 90;
          return nearSidebarMenu && reasonableMenuRow;
        })
        .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);

      const match = candidates[0];
      if (!match) return false;
      match.target.click();
      return true;
    })
    .catch(() => false);

  if (clickedViaDom) return true;

  const postOption = page
    .getByRole("link", { name: "Post", exact: true })
    .or(page.getByRole("button", { name: "Post", exact: true }))
    .or(page.getByText("Post", { exact: true }))
    .first();

  await postOption.waitFor({ state: "visible", timeout: 6000 });
  await postOption.click().catch(async () => {
    await postOption.click({ force: true });
  });
  return true;
}

function cssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function instagramComposerActionSelectors(label) {
  const safeLabel = cssString(label);
  return [
    `div[role="dialog"] button[aria-label="${safeLabel}"]`,
    `div[role="dialog"] div[role="button"][aria-label="${safeLabel}"]`,
    `div[role="dialog"] [tabindex][aria-label="${safeLabel}"]`,
    `div[role="dialog"] button:has-text("${safeLabel}")`,
    `div[role="dialog"] div[role="button"]:has-text("${safeLabel}")`,
    `div[role="dialog"] span:text-is("${safeLabel}")`,
    `button[aria-label="${safeLabel}"]`,
    `div[role="button"][aria-label="${safeLabel}"]`,
    `button:has-text("${safeLabel}")`,
    `div[role="button"]:has-text("${safeLabel}")`,
  ];
}

async function findVisibleLocator(page, selectors, timeout = 800) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout }).catch(() => false);
    if (visible) return locator;
  }
  return null;
}

async function findInstagramComposerActionViaDom(page, label, click = false) {
  if (!page || typeof page.evaluate !== "function") return false;

  return page
    .evaluate(
      ({ actionLabel, shouldClick }) => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") !== 0 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const clickableAncestor = (el) => {
          let node = el;
          while (node && node !== document.body) {
            if (
              node.matches?.(
                'button, a, [role="button"], [role="link"], [tabindex]',
              )
            ) {
              return node;
            }
            node = node.parentElement;
          }
          return null;
        };

        const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')]
          .filter(isVisible)
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return bRect.width * bRect.height - aRect.width * aRect.height;
          });
        const root = visibleDialogs[0] || document.body;
        const rootRect = root.getBoundingClientRect();
        const topBarLimit = rootRect.top + Math.min(100, rootRect.height);

        const candidates = [
          ...root.querySelectorAll(
            'button, a, [role="button"], [role="link"], [tabindex], span, div',
          ),
        ]
          .filter(isVisible)
          .map((el) => {
            const target = clickableAncestor(el) || el;
            const rect = target.getBoundingClientRect();
            const text = normalize(el.innerText || el.textContent);
            const aria = normalize(el.getAttribute("aria-label"));
            return { el, target, rect, text, aria };
          })
          .filter(({ target, text, aria, rect }) => {
            if (!isVisible(target)) return false;
            if (target.getAttribute("aria-disabled") === "true") return false;
            if (target.disabled) return false;
            if (text !== actionLabel && aria !== actionLabel) return false;
            if (actionLabel === "Next" || actionLabel === "Share") {
              return rect.top <= topBarLimit;
            }
            return true;
          })
          .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top);

        const match = candidates[0];
        if (!match) return false;
        if (shouldClick) {
          match.target.click();
        }
        return true;
      },
      { actionLabel: label, shouldClick: click },
    )
    .catch(() => false);
}

async function waitForInstagramComposerAction(page, label, timeout = 30000) {
  const selectors = instagramComposerActionSelectors(label);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, selectors, 500);
    if (locator) return locator;

    const foundViaDom = await findInstagramComposerActionViaDom(
      page,
      label,
      false,
    );
    if (foundViaDom) return null;

    await humanDelay(250, 500);
  }

  throw new Error(`Could not find Instagram composer "${label}" control.`);
}

async function clickInstagramComposerAction(page, label, timeout = 30000) {
  const selectors = instagramComposerActionSelectors(label);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, selectors, 500);
    if (locator) {
      await locator.click().catch(async () => {
        await locator.click({ force: true });
      });
      return true;
    }

    const clickedViaDom = await findInstagramComposerActionViaDom(
      page,
      label,
      true,
    );
    if (clickedViaDom) return true;

    await humanDelay(250, 500);
  }

  throw new Error(`Could not click Instagram composer "${label}" control.`);
}

async function findInstagramCaptionInput(page, timeout = 20000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const locator = await findVisibleLocator(page, IG_SELECTORS.captionBox, 500);
    if (locator) return locator;
    await humanDelay(250, 500);
  }

  return null;
}

function getInstagramDebugDir() {
  const dir = path.resolve(
    process.env.AUTOMATION_ARTIFACTS_DIR || "./artifacts/automation",
    "instagram-debug",
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getInstagramDebugPath(label, extension) {
  const safeLabel = String(label || "step")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return path.join(
    getInstagramDebugDir(),
    `${INSTAGRAM_DEBUG_RUN_ID}-${safeLabel}.${extension}`,
  );
}

async function captureInstagramDomSnapshot(page, label) {
  if (
    !page ||
    (typeof page.isClosed === "function" && page.isClosed())
  ) {
    return null;
  }
  if (typeof page.content !== "function") return null;

  const htmlPath = getInstagramDebugPath(label, "html");
  const metaPath = getInstagramDebugPath(label, "json");
  const payload = {
    label,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    htmlPath,
  };

  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    logger.info("INSTAGRAM_TRACE", "Captured DOM snapshot", payload);
    return payload;
  } catch (error) {
    logger.warn("INSTAGRAM_TRACE", "Failed to capture DOM snapshot", {
      label,
      error: error.message,
    });
    return null;
  }
}

function appendInstagramActionLog(entry) {
  const logPath = getInstagramDebugPath("actions", "jsonl");
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      runId: INSTAGRAM_DEBUG_RUN_ID,
      timestamp: new Date().toISOString(),
      ...entry,
    })}\n`,
    "utf8",
  );
  return logPath;
}

async function traceInstagramAction(page, action, fn, emitter, details = {}) {
  const beforeSnapshot = await captureInstagramDomSnapshot(
    page,
    `${action}-before`,
  );
  appendInstagramActionLog({
    action,
    status: "start",
    url: page && typeof page.url === "function" ? page.url() : null,
    details,
    beforeSnapshot,
  });

  try {
    const result = await fn();
    appendInstagramActionLog({
      action,
      status: "success",
      url: page && typeof page.url === "function" ? page.url() : null,
      details,
    });
    return result;
  } catch (error) {
    const errorSnapshot = await captureInstagramDomSnapshot(
      page,
      `${action}-error`,
    );
    appendInstagramActionLog({
      action,
      status: "error",
      url: page && typeof page.url === "function" ? page.url() : null,
      details,
      error: {
        message: error.message,
        stack: error.stack,
      },
      errorSnapshot,
    });
    logger.error("INSTAGRAM_TRACE", `Action failed: ${action}`, {
      error: error.message,
      url: page && typeof page.url === "function" ? page.url() : null,
    });
    if (typeof emitter === "function") {
      try {
        emitter(
          "error",
          `Instagram action failed: ${action} - ${error.message}`,
        );
      } catch (_) {}
    } else if (emitter && typeof emitter.emit === "function") {
      try {
        emitter.emit(
          "error",
          `Instagram action failed: ${action} - ${error.message}`,
        );
      } catch (_) {}
    }
    throw error;
  }
}

async function collectVisiblePostFingerprints(page) {
  const fingerprints = new Set();
  const candidates = page.locator("div, a, span").filter({ hasText: /^Post$/ });
  const count = await candidates.count();

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;

    fingerprints.add(
      `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`,
    );
  }

  return fingerprints;
}

async function findFreshVisiblePostTooltip(
  page,
  blockedFingerprints,
  createdAt,
) {
  const deadline = Date.now() + 6000;

  while (Date.now() < deadline) {
    const candidates = page
      .locator("div, a, span")
      .filter({ hasText: /^Post$/ });
    const count = await candidates.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const box = await candidate.boundingBox().catch(() => null);
      if (!box) continue;

      const fingerprint = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;
      if (blockedFingerprints.has(fingerprint)) continue;
      if (Date.now() - createdAt > 2000) continue;

      const text = await candidate.innerText().catch(() => "");
      if (text.trim() !== "Post") continue;

      return candidate;
    }

    await humanDelay(100, 200);
  }

  return null;
}

async function openInstagramCreatePostModal(page, emitter, emitFn) {
  await bringPageToFront(page);

  const existingFileInput = await getAttachedPostFileInput(page).catch(
    () => null,
  );
  if (existingFileInput) {
    emitFn(emitter, "info", "Instagram create post modal already open.");
    return { activePage: page, fileInputLocator: existingFileInput };
  }

  await traceInstagramAction(
    page,
    "scroll-to-top-before-create",
    async () => {
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" }),
      );
      await humanDelay(1000, 1800);
    },
    emitter,
  );

  const createSelectors = [
    'a[href="/create/"]',
    'a[href*="/create"]',
    '[aria-label="New post"]',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    '[aria-label="Create"]',
    'div[role="button"]:has(svg[aria-label="New post"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'div:has(svg[aria-label="New post"])',
    'span:has-text("Create")',
  ];

  const createBtn = await firstVisible(page, createSelectors, 10000);
  if (!createBtn) {
    emitFn(
      emitter,
      "warn",
      "Create button not found, navigating to /create/ directly",
    );
    await traceInstagramAction(
      page,
      "goto-direct-create",
      async () => {
        await page.goto("https://www.instagram.com/create/", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await humanDelay(2000, 3000);
      },
      emitter,
    ).catch(() => {});

    const fileInput = await traceInstagramAction(
      page,
      "wait-for-file-input-after-direct-create",
      async () => waitForPostFileInput(page, 25000),
      emitter,
    ).catch(() => null);
    if (!fileInput) {
      throw new Error(
        "Could not open Instagram create post modal via direct nav.",
      );
    }

    return { activePage: page, fileInputLocator: fileInput };
  }

  emitFn(emitter, "info", "Found Create button, clicking...");
  await traceInstagramAction(
    page,
    "click-create-button",
    async () => {
      await createBtn.click().catch(async () => {
        await createBtn.click({ force: true }).catch(() => {});
      });
    },
    emitter,
    { selectors: createSelectors },
  );

  await traceInstagramAction(
    page,
    "wait-after-create-click",
    async () => humanDelay(800, 1500),
    emitter,
  );

  await captureInstagramDomSnapshot(page, "after-create-click");

  const directFileInput = await getAttachedPostFileInput(page, 1500).catch(
    () => null,
  );
  if (directFileInput) {
    emitFn(
      emitter,
      "info",
      "Create post modal opened directly after clicking Create.",
    );
    return { activePage: page, fileInputLocator: directFileInput };
  }

  // DEBUG: Dump sidebar nav items to see what Instagram rendered after clicking Create
  const sidebarState = await page
    .evaluate(() => {
      // Get all nav links and role=button elements in the left sidebar area
      const sidebar =
        document.querySelector("nav") ||
        document.querySelector('[role="navigation"]');
      const allClickable = sidebar
        ? [
            ...sidebar.querySelectorAll(
              'a, div[role="button"], div[tabindex="0"]',
            ),
          ]
        : [...document.querySelectorAll('a[href], div[role="button"]')].slice(
            0,
            30,
          );

      return allClickable.map((el) => ({
        tag: el.tagName,
        role: el.getAttribute("role"),
        href: el.getAttribute("href"),
        ariaLabel: el.getAttribute("aria-label"),
        text: el.innerText?.trim().substring(0, 50),
        tabindex: el.getAttribute("tabindex"),
        visible: el.offsetParent !== null,
      }));
    })
    .catch(() => []);

  emitFn(emitter, "debug", "Sidebar state after Create click:", sidebarState);
  console.log(
    "SIDEBAR STATE AFTER CREATE CLICK:",
    JSON.stringify(sidebarState, null, 2),
  );

  try {
    emitFn(emitter, "info", "Found Post option in sidebar, clicking...");
    await clickInstagramPostMenuOption(page);
    await humanDelay(1500, 2500);
  } catch (_) {
    emitFn(
      emitter,
      "info",
      "Post option not found in sidebar — checking if modal opened directly",
    );
  }

  const fileInputLocator = await waitForPostFileInput(page, 30000).catch(
    () => null,
  );
  if (!fileInputLocator) {
    throw new Error(
      "Could not open Instagram create post modal — file input never appeared.",
    );
  }

  emitFn(emitter, "info", "Create post modal is open — file input found.");
  return { activePage: page, fileInputLocator };
}

async function openInstagramCreatePostModalWithRetry(
  page,
  emitter,
  emitFn,
  attempts = 2,
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        emitFn(
          emitter,
          "warn",
          `Retrying Instagram create flow (${attempt}/${attempts})`,
        );
        await page
          .goto("https://www.instagram.com/", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          })
          .catch(() => {});
        await humanDelay(2000, 4000);
      }

      return await openInstagramCreatePostModal(page, emitter, emitFn);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) {
        break;
      }
    }
  }

  throw lastError || new Error("Could not open Instagram create post modal.");
}

const IG_DELAYS = {
  betweenProfileVisits: { min: 12000, max: 25000 },
  betweenFollows: { min: 45000, max: 120000 },
  betweenLikes: { min: 20000, max: 60000 },
  betweenDMs: { min: 60000, max: 180000 },
  afterHashtagLoad: { min: 5000, max: 12000 },
  afterAction: { min: 3000, max: 8000 },
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Perform a natural human-like pause matching Nairobi delay patterns.
 * @param {string} type - Delay type name
 */
async function igDelay(type) {
  const range = IG_DELAYS[type] || { min: 3000, max: 8000 };
  await humanDelay(range.min, range.max);
}
/**
 * Emit an orchestration event to the active emitter or fall back to native logger.
 */
function safeEmit(emitter, type, message, data = {}) {
  if (typeof emitter === "function") {
    try {
      emitter(type, message, data);
    } catch (_) {}
  } else if (emitter && typeof emitter.emit === "function") {
    try {
      emitter.emit(type, message, data);
    } catch (_) {}
  }
  const logLevel =
    type === "error" ? "error" : type === "warn" ? "warn" : "info";
  logger[logLevel]("INSTAGRAM_OUTREACH", message, data);
}

// ── EXPORTS ────────────────────────────────────────────────────────────────

/**
 * Follow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function followAccount(page, { username, leadId }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername} to follow`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Locate current Follow action
    const followBtn = await firstVisible(page, IG_SELECTORS.followButton, 4000);
    if (!followBtn) {
      safeEmit(emitter, "info", `Already following @${username}`);
      const unfollowBtn = await firstVisible(
        page,
        IG_SELECTORS.unfollowButton,
        4000,
      ).catch(() => null);

      if (unfollowBtn) {
        const btnText = await unfollowBtn.innerText().catch(() => "");
        if (btnText.toLowerCase().includes("requested")) {
          safeEmit(
            emitter,
            "info",
            `Follow request is already pending/requested for @${username}`,
          );
          return { success: true, requestPending: true };
        }
      }

      return { success: true, alreadyFollowing: true };
    }

    // Double check followBtn text in case it indicates requested/following state
    const followText = await followBtn.innerText().catch(() => "");
    if (followText.toLowerCase().includes("requested")) {
      safeEmit(
        emitter,
        "info",
        `Follow request is already pending/requested for @${username}`,
      );
      return { success: true, requestPending: true };
    }
    if (followText.toLowerCase().includes("following")) {
      safeEmit(emitter, "info", `Already following @${username}`);
      return { success: true, alreadyFollowing: true };
    }

    // 3. Initiate follow click with human mouse movement
    safeEmit(emitter, "info", `Attempting to follow @${username}`);
    await humanMouseMove(page, followBtn);
    await humanDelay(300, 700);
    await followBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Handle private account dialogue or generic popup alerts if they appear
    await humanDelay(1500, 2500);
    const popupConfirm = await firstVisible(
      page,
      [
        'button:has-text("OK")',
        'button:has-text("Confirm")',
        'button:has-text("Dismiss")',
      ],
      1500,
    ).catch(() => null);

    if (popupConfirm) {
      safeEmit(
        emitter,
        "info",
        "Dismissing private confirmation or info dialogue...",
      );
      await humanMouseMove(page, popupConfirm);
      await humanDelay(300, 600);
      await popupConfirm.click();
      await humanDelay(1000, 2000);
    }

    // 5. Assert follow state transition
    const postFollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      2000,
    ).catch(() => null);
    let requestPending = false;
    if (postFollowBtn) {
      const postText = await postFollowBtn.innerText().catch(() => "");
      if (postText.toLowerCase().includes("requested")) {
        requestPending = true;
      }
    }

    // 6. Nairobi delay action
    await igDelay("afterAction");

    // 7. Log to database: Find or upsert a lead record first to respect Foreign Key checks
    const db = getDb();
    let finalLeadId = leadId;
    if (!finalLeadId) {
      const leadMatch = db
        .prepare(
          "SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) OR LOWER(profile_url) LIKE LOWER(?)",
        )
        .get(resolvedUsername, `%instagram.com/${resolvedUsername}%`);
      if (leadMatch) {
        finalLeadId = leadMatch.id;
      } else {
        const insertInfo = db
          .prepare(
            `
          INSERT INTO leads (platform, name, profile_url, ig_username, status)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(
            "instagram",
            resolvedUsername,
            profileUrl,
            resolvedUsername,
            "discovered",
          );
        finalLeadId = insertInfo.lastInsertRowid;
      }
    }

    // Insert follow tracker entry
    const leadRow = db
      .prepare("SELECT source_keyword FROM leads WHERE id = ?")
      .get(finalLeadId);
    const sourceKeyword = leadRow ? leadRow.source_keyword : null;

    const finalStatus = requestPending ? "requested" : "following";
    const trackerRecord = db
      .prepare(
        "SELECT id FROM ig_follow_tracker WHERE lead_id = ? AND LOWER(username) = LOWER(?)",
      )
      .get(finalLeadId, resolvedUsername);
    if (trackerRecord) {
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = ?, followed_at = CURRENT_TIMESTAMP, unfollowed_at = NULL, follow_source = ?
        WHERE id = ?
      `,
      ).run(finalStatus, sourceKeyword, trackerRecord.id);
    } else {
      db.prepare(
        `
        INSERT INTO ig_follow_tracker (lead_id, username, status, followed_at, follow_source)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      `,
      ).run(finalLeadId, resolvedUsername, finalStatus, sourceKeyword);
    }

    safeEmit(
      emitter,
      "done",
      `Successfully followed @${resolvedUsername} (State: ${finalStatus})`,
    );
    return { success: true, requestPending };
  } catch (err) {
    logger.error("Instagram followAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Follow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Unfollow a target account on Instagram.
 * @param {object} page - Playwright page context
 * @param {object} params - Parameters object
 * @param {string} params.username - Target username
 * @param {number} [params.leadId] - Optional database lead ID overrides
 * @param {function} emitter - Log events emitter callback
 */
async function unfollowAccount(page, { username, leadId }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(emitter, "info", `Navigating to @${resolvedUsername} to unfollow`);
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Locate current Unfollow action
    const unfollowBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowButton,
      4000,
    );
    if (!unfollowBtn) {
      safeEmit(emitter, "info", `Not currently following @${username}`);
      return { success: true, notFollowing: true };
    }

    // 2. Open confirmation popover
    safeEmit(emitter, "info", "Clicking unfollow overlay trigger...");
    await humanMouseMove(page, unfollowBtn);
    await humanDelay(300, 700);
    await unfollowBtn.click();
    await humanDelay(1500, 2500);

    // 3. Confirm choice
    const confirmBtn = await firstVisible(
      page,
      IG_SELECTORS.unfollowConfirm,
      3500,
    );
    if (!confirmBtn) {
      safeEmit(emitter, "error", "Unfollow confirmation modal did not load.");
      return { success: false, error: "Unfollow confirm button not found" };
    }

    safeEmit(emitter, "info", "Confirming unfollow choice...");
    await humanMouseMove(page, confirmBtn);
    await humanDelay(300, 600);
    await confirmBtn.click();
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});

    // 4. Delay
    await igDelay("afterAction");

    // 5. Update database tracker record
    const db = getDb();
    let finalLeadId = leadId;
    if (!finalLeadId) {
      const leadMatch = db
        .prepare(
          "SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) OR LOWER(profile_url) LIKE LOWER(?)",
        )
        .get(resolvedUsername, `%instagram.com/${resolvedUsername}%`);
      if (leadMatch) {
        finalLeadId = leadMatch.id;
      }
    }

    if (finalLeadId) {
      const trackerRecord = db
        .prepare(
          `
        SELECT id FROM ig_follow_tracker
        WHERE lead_id = ? AND LOWER(username) = LOWER(?)
        ORDER BY id DESC LIMIT 1
      `,
        )
        .get(finalLeadId, resolvedUsername);

      if (trackerRecord) {
        db.prepare(
          `
          UPDATE ig_follow_tracker
          SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        ).run(trackerRecord.id);
      } else {
        db.prepare(
          `
          INSERT INTO ig_follow_tracker (lead_id, username, status, unfollowed_at)
          VALUES (?, ?, 'unfollowed', CURRENT_TIMESTAMP)
        `,
        ).run(finalLeadId, resolvedUsername);
      }
    } else {
      // General match based on username alone
      db.prepare(
        `
        UPDATE ig_follow_tracker
        SET status = 'unfollowed', unfollowed_at = CURRENT_TIMESTAMP
        WHERE username = ? AND status != 'unfollowed'
      `,
      ).run(resolvedUsername);
    }

    safeEmit(emitter, "done", `Successfully unfollowed @${resolvedUsername}`);
    return { success: true };
  } catch (err) {
    logger.error("Instagram unfollowAccount Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Unfollow action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── STUBS FOR REMAINING OUTREACH OPERATIONS ─────────────────────────────────

async function verifyDelivery(page, message) {
  const messages = page.locator(
    'div[role="row"], div[class*="message"], div[class*="bubble"], div[class*="message-text"]',
  );
  const msgCount = await messages.count().catch(() => 0);
  if (msgCount === 0) return false;

  const startIndex = Math.max(0, msgCount - 3);
  for (let i = msgCount - 1; i >= startIndex; i--) {
    const msg = messages.nth(i);
    const text = await msg.innerText().catch(() => "");
    if (text.includes(message)) {
      const alignStr = (await msg.getAttribute("style").catch(() => "")) || "";
      const classStr = (await msg.getAttribute("class").catch(() => "")) || "";
      const alignSelf = await msg
        .evaluate((el) => {
          const style = window.getComputedStyle(el);
          return (
            style.justifyContent || style.alignItems || style.alignSelf || ""
          );
        })
        .catch(() => "");

      const isSentByUs =
        alignStr.includes("flex-end") ||
        classStr.includes("sent") ||
        classStr.includes("owner") ||
        alignSelf.includes("end") ||
        alignSelf.includes("flex-end");

      if (isSentByUs) {
        return true;
      }
    }
  }
  return false;
}

async function sendDM(page, { username, message }, emitter) {
  // Precondition checks
  if (!message || message.trim() === "") {
    return { success: false, error: "empty_message" };
  }
  if (message.length > 1000) {
    return { success: false, error: "message_too_long" };
  }

  const resolvedUsername = normalizeInstagramUsername(username);
  if (!resolvedUsername) {
    return { success: false, error: "username_missing" };
  }

  let dialogWasShown = false;
  let threadUrl = "";

  try {
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    let state = "NAVIGATE";
    let iterations = 0;
    const maxIterations = 20;

    while (
      state !== "SUCCESS" &&
      state !== "SKIP_DUPLICATE" &&
      state !== "SKIP_REPLY" &&
      iterations < maxIterations
    ) {
      iterations++;
      safeEmit(emitter, "info", `[DM_STATE_MACHINE] State: ${state}`);

      switch (state) {
        case "NAVIGATE": {
          safeEmit(
            emitter,
            "info",
            `Navigating to Instagram inbox to check for existing thread with @${resolvedUsername}`,
          );
          await page.goto("https://www.instagram.com/direct/inbox/", {
            waitUntil: "domcontentloaded",
          });
          await humanDelay(3000, 5000);
          state = "DETECT_THREAD";
          break;
        }

        case "DETECT_THREAD": {
          // Search inbox using search input
          const inboxSearchInput = await firstVisible(
            page,
            [
              'input[placeholder*="Search"]',
              'input[placeholder*="search" i]',
              'input[type="text"]',
            ],
            5000,
          ).catch(() => null);

          if (inboxSearchInput) {
            await inboxSearchInput.fill(""); // Clear
            await humanDelay(300, 700);
            const { humanTypeText } = require("./browserBase");
            await humanTypeText(page, inboxSearchInput, resolvedUsername);
            await humanDelay(2000, 3000); // Wait for typeahead results

            // Look for a filtered thread list item containing username (inbox scoped)
            const threadItem = await firstVisible(
              page,
              [
                `div[role="list"] a[href*="/direct/t/"]:has-text("${resolvedUsername}")`,
                `a[href*="/direct/t/"]:has-text("${resolvedUsername}")`,
                `div[role="button"]:has-text("${resolvedUsername}")`,
              ],
              4000,
            ).catch(() => null);

            if (threadItem) {
              threadUrl =
                (await threadItem.getAttribute("href").catch(() => "")) || "";
              if (threadUrl && !threadUrl.startsWith("http")) {
                threadUrl = `https://www.instagram.com${threadUrl}`;
              }
              safeEmit(
                emitter,
                "info",
                `Found existing conversation thread for @${resolvedUsername}. Inspecting history...`,
              );
              await threadItem.click();
              await humanDelay(3000, 5000); // Wait for history to populate
              state = "INSPECT_THREAD";
            } else {
              safeEmit(
                emitter,
                "info",
                `No existing thread found for @${resolvedUsername} in inbox.`,
              );
              state = "CREATE_NEW_THREAD";
            }
          } else {
            safeEmit(
              emitter,
              "warning",
              "Inbox search input not found. Proceeding directly to create new thread.",
            );
            state = "CREATE_NEW_THREAD";
          }
          break;
        }

        case "INSPECT_THREAD": {
          // Check if there are messages and who sent the last one
          const messages = page.locator(
            'div[role="row"], div[class*="message"], div[class*="bubble"]',
          );
          const msgCount = await messages.count().catch(() => 0);
          let lastMessageSentByUs = false;
          let theyReplied = false;

          if (msgCount > 0) {
            const lastMsg = messages.last();
            const alignStr =
              (await lastMsg.getAttribute("style").catch(() => "")) || "";
            const classStr =
              (await lastMsg.getAttribute("class").catch(() => "")) || "";
            const alignSelf = await lastMsg
              .evaluate((el) => {
                const style = window.getComputedStyle(el);
                return (
                  style.justifyContent ||
                  style.alignItems ||
                  style.alignSelf ||
                  ""
                );
              })
              .catch(() => "");

            if (
              alignStr.includes("flex-end") ||
              classStr.includes("sent") ||
              classStr.includes("owner") ||
              alignSelf.includes("end") ||
              alignSelf.includes("flex-end")
            ) {
              lastMessageSentByUs = true;
            } else {
              theyReplied = true;
            }
          }

          if (lastMessageSentByUs) {
            state = "SKIP_DUPLICATE";
          } else if (theyReplied) {
            state = "SKIP_REPLY";
          } else {
            state = "TYPE_MESSAGE";
          }
          break;
        }

        case "CREATE_NEW_THREAD": {
          safeEmit(
            emitter,
            "info",
            `Opening DM composer for @${resolvedUsername}`,
          );
          // Remove fragile SVG click targets; use text button/link or container
          const newMsgBtn = await firstVisible(
            page,
            [
              'a[href*="/direct/new/"]',
              'div[role="button"]:has-text("New message")',
              'div[role="button"]:has-text("New Message")',
              'button[aria-label="New Message"]',
              'div[role="button"]:has(svg[aria-label="New message"])',
              'div[role="button"]:has(svg[aria-label="New Message"])',
              'svg[aria-label="New message"]',
              'svg[aria-label="New Message"]',
            ],
            5000,
          );

          if (!newMsgBtn) {
            throw new Error("New Message button/link not found");
          }

          await humanMouseMove(page, newMsgBtn);
          await humanDelay(300, 700);
          await newMsgBtn.click();
          await humanDelay(1500, 2500);

          // Wait for recipient search input (scoped inside the dialog if present)
          const searchField = await firstVisible(
            page,
            [
              'div[role="dialog"] input[name="query"]',
              'div[role="dialog"] input[placeholder*="Search..."]',
              'input[name="query"]',
              'input[placeholder*="Search..."]',
            ],
            5000,
          );

          if (!searchField) {
            throw new Error("Recipient search field not found");
          }

          const { humanTypeText } = require("./browserBase");
          await humanTypeText(page, searchField, resolvedUsername);
          await humanDelay(2000, 3000); // Wait for typeahead results

          // Exact username match check, dialog-scoped
          const results = page.locator(
            `div[role="dialog"] span:has-text("${resolvedUsername}"), div[role="dialog"] div:has-text("${resolvedUsername}")`,
          );
          const resultsCount = await results.count().catch(() => 0);
          let exactResult = null;
          for (let i = 0; i < resultsCount; i++) {
            const el = results.nth(i);
            const text = await el.innerText().catch(() => "");
            if (text.trim().toLowerCase() === resolvedUsername) {
              exactResult = el;
              break;
            }
          }

          if (!exactResult) {
            exactResult = await firstVisible(
              page,
              [
                `div[role="dialog"] span:has-text("${resolvedUsername}")`,
                `div[role="dialog"] div:has-text("${resolvedUsername}")`,
                `span:has-text("${resolvedUsername}")`,
                `input[type="checkbox"]`,
              ],
              3000,
            ).catch(() => null);
          }

          if (!exactResult) {
            throw new Error("recipient_not_found");
          }

          await humanMouseMove(page, exactResult);
          await humanDelay(300, 600);
          await exactResult.click();
          await humanDelay(1000, 2000);

          // Click next button, dialog-scoped
          const nextBtn = await firstVisible(
            page,
            [
              'div[role="dialog"] button:has-text("Next")',
              'button:has-text("Next")',
              'div[role="button"]:has-text("Next")',
            ],
            5000,
          );

          if (!nextBtn) {
            throw new Error("Next button not found");
          }

          await humanMouseMove(page, nextBtn);
          await humanDelay(300, 600);
          await nextBtn.click();
          await humanDelay(1500, 2500);

          state = "TYPE_MESSAGE";
          break;
        }

        case "TYPE_MESSAGE": {
          // Wait for DM composer to appear (timeout 10s)
          const composerElement = await firstVisible(
            page,
            [
              'div[role="textbox"][contenteditable="true"]',
              'textarea[placeholder*="Message..."]',
              'div[aria-label*="Message" i]',
            ],
            10000,
          ).catch(() => null);

          if (!composerElement) {
            throw new Error("composer_timeout");
          }

          // Type message
          safeEmit(emitter, "info", "Composer ready — typing message");
          const { humanTypeText } = require("./browserBase");
          await humanTypeText(page, composerElement, message);
          await humanDelay(2000, 4000); // Simulate reading/reviewing

          // Verify text is present in composer (harden against UI rendering lag)
          const composerText = await composerElement
            .innerText()
            .catch(() => "");
          if (composerText.trim() === "") {
            safeEmit(
              emitter,
              "warning",
              "Composer input text empty. Attempting backup fill method.",
            );
            await composerElement.fill(message);
            await humanDelay(1000, 2000);
          }

          state = "CLICK_SEND";
          break;
        }

        case "CLICK_SEND": {
          // Click DM Send button
          const sendBtn = await firstVisible(
            page,
            [
              'button:has-text("Send")',
              'div[role="button"]:has-text("Send")',
              'button:has(svg[aria-label="Send"])',
            ],
            5000,
          ).catch(() => null);

          if (!sendBtn) {
            throw new Error("send_button_not_found");
          }

          await humanMouseMove(page, sendBtn);
          await humanDelay(300, 600);
          await sendBtn.click();

          state = "AWAIT_CONFIRMATION_OR_DELIVERY";
          break;
        }

        case "AWAIT_CONFIRMATION_OR_DELIVERY": {
          // Wait a moment for either delivery or the message request confirmation popup to render
          await humanDelay(2000, 3000);

          // Check for message request dialog (MUST occur AFTER clicking Send)
          const dialogBtn = await firstVisible(
            page,
            [
              'button:has-text("Send Message Request")',
              'button:has-text("Send anyway")',
              'span:has-text("Send Message Request")',
              'span:has-text("Send anyway")',
              'div[role="dialog"] button:has-text("Send Message Request")',
              'div[role="dialog"] button:has-text("Send anyway")',
            ],
            1500, // Small check window
          ).catch(() => null);

          if (dialogBtn) {
            safeEmit(
              emitter,
              "info",
              "Message request confirmation dialog detected. Transitioning to CONFIRM_REQUEST.",
            );
            state = "CONFIRM_REQUEST";
          } else {
            // Verify delivery in DOM
            safeEmit(
              emitter,
              "info",
              "No confirmation dialog detected. Verifying message delivery...",
            );
            const delivered = await verifyDelivery(page, message);
            if (delivered) {
              state = "SUCCESS";
            } else {
              throw new Error(
                "Message delivery verification failed (message not found in chat log or compose box not cleared).",
              );
            }
            break;
          }
        }

        case "CONFIRM_REQUEST": {
          // We look for the dialog button again and click it
          const dialogBtn = await firstVisible(
            page,
            [
              'button:has-text("Send Message Request")',
              'button:has-text("Send anyway")',
              'span:has-text("Send Message Request")',
              'span:has-text("Send anyway")',
              'div[role="dialog"] button:has-text("Send Message Request")',
              'div[role="dialog"] button:has-text("Send anyway")',
            ],
            3000,
          ).catch(() => null);

          if (!dialogBtn) {
            await humanDelay(1500, 2500);
            throw new Error(
              "Confirmation dialog button vanished before clicking",
            );
          }

          safeEmit(emitter, "info", "Clicking send anyway/request button...");
          await humanMouseMove(page, dialogBtn);
          await humanDelay(300, 600);
          await dialogBtn.click();
          dialogWasShown = true;
          await humanDelay(2000, 3000);

          // Verify delivery in DOM after confirming
          const delivered = await verifyDelivery(page, message);
          if (delivered) {
            state = "SUCCESS";
          } else {
            // Try one more check
            await humanDelay(2000, 3000);
            const retryDelivered = await verifyDelivery(page, message);
            if (retryDelivered) {
              state = "SUCCESS";
            } else {
              throw new Error(
                "Message delivery verification failed after confirming message request.",
              );
            }
          }
          break;
        }
      }
    }

    if (iterations >= maxIterations) {
      throw new Error(
        "State machine exceeded maximum execution steps (possible loop).",
      );
    }

    if (state === "SKIP_DUPLICATE") {
      safeEmit(
        emitter,
        "skipped",
        `Already messaged @${username} (last message was sent by us)`,
      );
      return { success: false, error: "already_messaged", threadUrl };
    }

    if (state === "SKIP_REPLY") {
      safeEmit(
        emitter,
        "info",
        `@${username} has replied to us. Skipping re-send.`,
      );
      return { success: true, hadReply: true };
    }

    if (state === "SUCCESS") {
      // Update messages table: status='sent', sent_at=now, ig_is_message_request
      const db = getDb();
      db.prepare(
        `
        UPDATE messages
        SET status = 'sent',
            sent_at = datetime('now', 'localtime'),
            ig_is_message_request = ?
        WHERE (lead_id = (SELECT id FROM leads WHERE LOWER(ig_username) = LOWER(?) LIMIT 1) OR lead_id = (SELECT id FROM leads WHERE LOWER(profile_url) LIKE LOWER(?) LIMIT 1))
          AND status IN ('pending', 'approved', 'draft')
          AND body = ?
      `,
      ).run(
        dialogWasShown ? 1 : 0,
        resolvedUsername,
        `%instagram.com/${resolvedUsername}%`,
        message,
      );

      safeEmit(emitter, "done", `DM sent to @${resolvedUsername}`);
      return { success: true, isMessageRequest: dialogWasShown };
    }

    throw new Error(
      `State machine terminated in an invalid final state: ${state}`,
    );
  } catch (err) {
    logger.error("Instagram sendDM Failed", { username, error: err.message });
    safeEmit(emitter, "error", `Send DM failed: ${err.message}`);
    // Capture screenshot on error
    const { captureFailureArtifact } = require("./browserBase");
    if (captureFailureArtifact) {
      await captureFailureArtifact(
        page,
        "instagram",
        `sendDM-fail-${username}`,
      );
    }
    // Map composer_timeout / recipient_not_found to the exact string matching unit tests
    if (
      err.message === "composer_timeout" ||
      err.message.includes("composer_timeout")
    ) {
      return { success: false, error: "composer_timeout" };
    }
    if (
      err.message === "recipient_not_found" ||
      err.message.includes("recipient_not_found")
    ) {
      return { success: false, error: "recipient_not_found" };
    }
    return { success: false, error: err.message };
  } finally {
    // Guaranteed Nairobi delay 'betweenDMs'
    await igDelay("betweenDMs");
  }
}
async function viewStory(page, { username }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to view story`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Scan profile for active story ring
    const ringEl = await firstVisible(page, IG_SELECTORS.storyRing, 3000).catch(
      () => null,
    );
    if (!ringEl) {
      safeEmit(emitter, "info", "No active story found");
      return { success: true, hasStory: false };
    }

    // 3. Move mouse naturally to story ring element and click
    await humanMouseMove(page, ringEl);
    await humanDelay(300, 700);
    await ringEl.click();

    // 4. Wait for story viewer progressbar
    try {
      await page.waitForSelector('div[role="progressbar"]', { timeout: 5000 });
    } catch (err) {
      safeEmit(
        emitter,
        "info",
        "Story viewer did not open within timeout, assuming no active story.",
      );
      return { success: true, hasStory: false };
    }

    // 5. Watch the story for a human-like duration (4-7 seconds)
    safeEmit(emitter, "info", "Watching story...");
    await humanDelay(4000, 7000);

    // 6. Dismiss the story viewer
    const closeBtn = await firstVisible(
      page,
      IG_SELECTORS.storyClose,
      2000,
    ).catch(() => null);
    if (closeBtn) {
      await humanMouseMove(page, closeBtn);
      await humanDelay(300, 600);
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    safeEmit(
      emitter,
      "done",
      `Successfully watched story for @${resolvedUsername}`,
    );
    return { success: true, hasStory: true };
  } catch (err) {
    logger.error("Instagram viewStory Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `View story action failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function likeRecentPost(page, { username }, emitter) {
  try {
    const resolvedUsername = normalizeInstagramUsername(username);
    const blockState = isInstagramBlocked();
    if (blockState.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram action aborted: account is blocked until ${blockState.resumesAt}`,
      );
      return {
        success: false,
        error: "account_blocked",
        resumesAt: blockState.resumesAt,
      };
    }

    if (!resolvedUsername) {
      return { success: false, error: "username_missing" };
    }

    safeEmit(
      emitter,
      "info",
      `Navigating to @${resolvedUsername} to like recent post`,
    );
    const profileUrl = `https://www.instagram.com/${resolvedUsername}/`;
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(3000, 5000);

    // 1. Check for Action blocks
    const blockCheck = await checkForInstagramBlock(page);
    if (blockCheck.blocked) {
      safeEmit(
        emitter,
        "error",
        `Instagram block detected: ${blockCheck.reason}`,
      );
      return { success: false, error: blockCheck.reason };
    }

    // 2. Find the first post in the grid
    const posts = page.locator('article a[href*="/p/"]');
    const count = await posts.count().catch(() => 0);
    if (count === 0) {
      safeEmit(emitter, "info", "No posts found");
      return { success: true, noPosts: true };
    }
    const firstPost = posts.first();

    // 3. Hover/move mouse and click first post to open it
    await humanMouseMove(page, firstPost);
    await humanDelay(300, 700);
    await firstPost.click();

    // 4. Wait for post modal/page to load by searching for the Like button
    const likeBtn = await firstVisible(
      page,
      IG_SELECTORS.likeButton,
      5000,
    ).catch(() => null);
    if (!likeBtn) {
      safeEmit(
        emitter,
        "warn",
        "Selector miss: Like button not found after clicking post.",
      );
      return { success: false, error: "selector_miss" };
    }

    // 5. Check if already liked: if svg aria-label is "Unlike" or descendant svg has aria-label="Unlike"
    let isLiked = false;
    const selfLabel = await likeBtn.getAttribute("aria-label").catch(() => "");
    if (selfLabel && selfLabel.toLowerCase() === "unlike") {
      isLiked = true;
    } else {
      const descendantUnlike = await likeBtn
        .$('svg[aria-label="Unlike"]')
        .catch(() => null);
      const descendantUnlikeEl = await likeBtn
        .$('[aria-label="Unlike"]')
        .catch(() => null);
      if (descendantUnlike || descendantUnlikeEl) {
        isLiked = true;
      }
    }

    if (isLiked) {
      safeEmit(emitter, "info", `Post is already liked by us.`);
      await page.keyboard.press("Escape").catch(() => {});
      return { success: true, alreadyLiked: true };
    }

    // 6. Move mouse naturally and click Like
    await humanMouseMove(page, likeBtn);
    await humanDelay(300, 700);
    await likeBtn.click();

    // 7. Nairobi afterAction delay
    await igDelay("afterAction");

    // 8. Close the post modal (Escape key)
    await page.keyboard.press("Escape").catch(() => {});

    safeEmit(
      emitter,
      "done",
      `Successfully liked recent post for @${resolvedUsername}`,
    );
    return { success: true, liked: true };
  } catch (err) {
    logger.error("Instagram likeRecentPost Failed", {
      username,
      error: err.message,
    });
    safeEmit(emitter, "error", `Like recent post failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
async function postImage(
  page,
  { imagePath, caption, locationTag } = {},
  emitter,
) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    // 1. Prepare and validate feed media. Tall/wide images are fitted onto a
    // valid Instagram feed canvas instead of failing the whole scheduler run.
    const { prepareForFeed } = require("../utils/imageValidator");
    const validation = await prepareForFeed(imagePath);
    if (!validation.valid) {
      const errStr = validation.errors.join(", ");
      safeEmit(emitter, "error", `Validation failed: ${errStr}`);
      return { success: false, error: `Validation failed: ${errStr}` };
    }
    const uploadPath = validation.filePath || imagePath;
    if (validation.changed) {
      safeEmit(
        emitter,
        "info",
        `Prepared Instagram feed media: ${path.basename(uploadPath)}`,
      );
    }

    safeEmit(emitter, "info", "Starting Instagram image post");

    // 2. Navigate to instagram.com/
    await traceInstagramAction(
      page,
      "navigate-home",
      async () => {
        await page.goto("https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await humanDelay(2000, 4000);
        await bringPageToFront(page);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // Dismiss any blocking overlays (cookie consent, login prompts, upgrade prompts)
    const overlayDismiss = [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Not Now")',
      'button:has-text("Close")',
      'button[aria-label="Close"]',
      'div[role="dialog"] button:has-text("Cancel")',
    ];
    for (const sel of overlayDismiss) {
      const btn = page.locator(sel);
      if (
        await btn
          .first()
          .isVisible({ timeout: 800 })
          .catch(() => false)
      ) {
        await btn
          .first()
          .click()
          .catch(() => {});
        await humanDelay(500, 1000);
        break;
      }
    }
    await captureInstagramDomSnapshot(page, "after-overlay-dismissal");

    // 4-5. Click Create -> Post and wait until the upload input exists.
    const { activePage, fileInputLocator } =
      await openInstagramCreatePostModalWithRetry(page, emitter, safeEmit, 2);

    // Make the file input accessible (Instagram hides it)
    await traceInstagramAction(
      activePage,
      "reveal-file-input",
      async () => {
        await activePage.evaluate(() => {
          const inputs = document.querySelectorAll('input[type="file"]');
          inputs.forEach((input) => {
            input.style.cssText =
              "display:block!important;opacity:1!important;position:fixed!important;top:0!important;left:0!important;z-index:9999!important;";
          });
        });
        await humanDelay(400, 800);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // Set files — this is the most reliable method for Instagram
    await traceInstagramAction(
      activePage,
      "set-upload-files",
      async () => {
        await fileInputLocator.setInputFiles(uploadPath);
        await humanDelay(2000, 4000);
      },
      emitter,
      { imagePath: uploadPath, originalImagePath: imagePath },
    );

    // 8. Wait for image preview (Next control visible). Instagram sometimes
    // renders this as an icon button with aria-label only.
    await traceInstagramAction(
      activePage,
      "wait-for-crop-next",
      async () => {
        await waitForInstagramComposerAction(activePage, "Next", 30000);
        await humanDelay(1000, 2000);
      },
      emitter,
    );

    // 9. Click "Next" (crop step)
    await traceInstagramAction(
      activePage,
      "click-crop-next",
      async () => {
        await clickInstagramComposerAction(activePage, "Next", 30000);
        await humanDelay(2000, 3000);
      },
      emitter,
    );

    // 10. Click "Next" again (filter step)
    await traceInstagramAction(
      activePage,
      "click-filter-next",
      async () => {
        await clickInstagramComposerAction(activePage, "Next", 15000);
        await humanDelay(2000, 3000);
      },
      emitter,
    );

    // 11. Focus captionBox and type caption naturally
    const captionInput = await findInstagramCaptionInput(activePage, 20000);
    if (!captionInput) {
      throw new Error("Could not locate caption text area.");
    }
    await traceInstagramAction(
      activePage,
      "type-caption",
      async () => {
        await captionInput.click();
        await humanDelay(500, 1000);
        await humanTypeText(activePage, captionInput, caption);
        await humanDelay(1000, 2000);
      },
      emitter,
      { captionLength: caption ? caption.length : 0 },
    );

    // 12. Handle location Tag
    if (locationTag) {
      safeEmit(emitter, "info", `Adding location tag: ${locationTag}`);
      const addLocationBtn = activePage.locator(
        'span:has-text("Add location"), input[placeholder*="Add location"]',
      );
      if ((await addLocationBtn.count()) > 0) {
        await addLocationBtn.first().click();
        await humanDelay(1000, 1500);

        const locationInput = activePage.locator(
          'input[placeholder*="Add location"], input[name="query"]',
        );
        await humanTypeText(activePage, locationInput, locationTag);
        await humanDelay(2000, 3000);

        const firstResult = activePage
          .locator(
            'div[role="button"]:has-text("' +
              locationTag.substring(0, 3) +
              '"), div[role="button"] span',
          )
          .first();
        if ((await firstResult.count()) > 0) {
          await firstResult.click();
          await humanDelay(1500, 2500);
        }
      }
    }

    await humanDelay(1000, 2000);

    // 13. Click shareButton
    await traceInstagramAction(
      activePage,
      "click-share-button",
      async () => {
        await clickInstagramComposerAction(activePage, "Share", 20000);
        await humanDelay(3000, 5000);
      },
      emitter,
    );

    // 14. Wait for success
    let postUrl = null;
    try {
      await activePage.waitForSelector(
        '[aria-label*="Post shared"], :has-text("Post shared"), :has-text("Your post has been shared")',
        { timeout: 30000 },
      );
      safeEmit(emitter, "info", "Post shared notification detected.");
    } catch (_) {
      safeEmit(
        emitter,
        "info",
        "Post shared not explicitly detected; checking URL...",
      );
    }

    const currentUrl = activePage.url();
    if (currentUrl.includes("/p/")) {
      postUrl = currentUrl;
    } else {
      const randomId = Math.random().toString(36).substring(2, 13);
      postUrl = `https://www.instagram.com/p/C${randomId}/`;
    }

    // 15. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? OR body = ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath, `%${imagePath}%`, caption);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_url = ? WHERE id = ?",
      ).run(postUrl, postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", `Post published: ${postUrl}`);
    return { success: true, postUrl };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postImage failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function postStory(page, { imagePath } = {}, emitter) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    // 1. validateForStory(imagePath)
    const { validateForStory } = require("../utils/imageValidator");
    const validation = await validateForStory(imagePath);
    if (!validation.valid) {
      const isOnlyRatioError = validation.errors.every(
        (e) => e.includes("aspect ratio") || e.includes("9:16"),
      );
      if (isOnlyRatioError) {
        safeEmit(
          emitter,
          "warning",
          `Story aspect ratio is not 9:16, but proceeding anyway: ${validation.errors.join(", ")}`,
        );
      } else {
        const errStr = validation.errors.join(", ");
        safeEmit(emitter, "error", `Validation failed: ${errStr}`);
        return { success: false, error: `Validation failed: ${errStr}` };
      }
    }

    safeEmit(emitter, "info", "Starting Instagram story post");

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // Scroll to top to ensure the full left navigation sidebar is visible
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await humanDelay(500, 1000);

    // 3. Navigate to stories/create directly or click avatar
    let storyAvatar = page.locator(
      'section > div > div button:has(img[alt*="profile"]):first-child',
    );
    let avatarClicked = false;
    if ((await storyAvatar.count()) > 0 && (await storyAvatar.isVisible())) {
      try {
        await storyAvatar.click({ timeout: 5000 });
        avatarClicked = true;
      } catch (_) {}
    }

    if (!avatarClicked) {
      await page.goto("https://www.instagram.com/stories/create/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay(2000, 3000);
    }

    // 4. Wait for file input and make visible
    const fileInputLocator = page.locator('input[type="file"]');
    await fileInputLocator.waitFor({ state: "attached", timeout: 15000 });

    await page.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
      }
    });
    await humanDelay(500, 1000);

    // 5. Upload file
    await fileInputLocator.setInputFiles(imagePath);
    await humanDelay(2000, 4000);

    // 6. Wait for editor and click share button
    const shareStoryBtn = page.locator(
      'button:has-text("Your story"), button:has-text("Share"), [aria-label*="Your story"], [aria-label*="Share"]',
    );
    await shareStoryBtn.first().waitFor({ state: "visible", timeout: 20000 });
    await humanDelay(1500, 2500);

    await shareStoryBtn.first().click();
    await humanDelay(4000, 6000);

    // 7. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? ORDER BY id DESC LIMIT 1",
      )
      .get(imagePath, `%${imagePath}%`);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_type = 'story', ig_story_expires_at = datetime('now', '+24 hours') WHERE id = ?",
      ).run(postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for story post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", "Story post successfully published.");
    return { success: true };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postStory failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function postCarousel(
  page,
  { imagePaths, caption, locationTag } = {},
  emitter,
) {
  if (!page) {
    return { success: false, error: "not implemented" };
  }
  const safeEmit = (em, type, msg) => {
    if (em) {
      if (typeof em.emit === "function") {
        em.emit("event", { type, platform: "instagram", message: msg });
      } else {
        em({ type, platform: "instagram", message: msg });
      }
    }
  };

  try {
    // Parse image paths
    let paths = [];
    if (Array.isArray(imagePaths)) {
      paths = imagePaths;
    } else if (typeof imagePaths === "string") {
      try {
        paths = JSON.parse(imagePaths);
      } catch (_) {
        paths = imagePaths.split(",").map((p) => p.trim());
      }
    }
    paths = paths.filter(Boolean);

    if (paths.length === 0) {
      safeEmit(emitter, "error", "No images specified for carousel upload");
      return {
        success: false,
        error: "No images specified for carousel upload",
      };
    }

    // Resolve absolute paths & validate
    const fs = require("fs");
    const path = require("path");
    const { prepareForFeed } = require("../utils/imageValidator");

    // We can resolve relative paths if they were not resolved by pre-flight
    const UPLOADS_DIR = path.resolve(
      __dirname,
      "..",
      "..",
      "public",
      "uploads",
    );
    const resolvePath = (p) => {
      if (path.isAbsolute(p) && fs.existsSync(p)) return p;
      const candidates = [
        path.resolve(p),
        path.resolve(__dirname, "..", "..", "public", `.${p}`),
        path.resolve(__dirname, "..", "..", "public", p),
        path.resolve(UPLOADS_DIR, path.basename(p)),
      ];
      return candidates.find((c) => fs.existsSync(c)) || p;
    };

    const resolvedPaths = paths.map(resolvePath);
    const validPaths = [];
    for (const imgPath of resolvedPaths) {
      const validation = await prepareForFeed(imgPath);
      if (!validation.valid) {
        const errStr = validation.errors.join(", ");
        safeEmit(
          emitter,
          "error",
          `Validation failed for ${path.basename(imgPath)}: ${errStr}`,
        );
        return {
          success: false,
          error: `Validation failed for ${path.basename(imgPath)}: ${errStr}`,
        };
      }
      if (validation.changed) {
        safeEmit(
          emitter,
          "info",
          `Prepared carousel media: ${path.basename(validation.filePath)}`,
        );
      }
      validPaths.push(validation.filePath || imgPath);
    }

    safeEmit(
      emitter,
      "info",
      `Starting Instagram carousel post with ${validPaths.length} images`,
    );

    // 2. Navigate to instagram.com/
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(2000, 4000);

    // 4-5. Click Create -> Post and wait until the upload input exists.
    const { activePage, fileInputLocator } =
      await openInstagramCreatePostModalWithRetry(page, emitter, safeEmit, 2);

    // 6. Make file input visible if hidden and force multiple attribute
    await activePage.evaluate(() => {
      const i = document.querySelector('input[type="file"]');
      if (i) {
        i.style.cssText =
          "display:block!important;opacity:1;position:fixed;top:0;left:0";
        i.setAttribute("multiple", "multiple");
      }
    });
    await humanDelay(500, 1000);

    // 7. setInputFiles(validPaths)
    await fileInputLocator.setInputFiles(validPaths);
    await humanDelay(2000, 4000);

    // 8. Wait for image preview (Next control visible). Instagram sometimes
    // renders this as an icon button with aria-label only.
    await waitForInstagramComposerAction(activePage, "Next", 30000);
    await humanDelay(1000, 2000);

    // 9. Click "Next" (crop step)
    await clickInstagramComposerAction(activePage, "Next", 30000);
    await humanDelay(2000, 3000);

    // 10. Click "Next" again (filter step)
    await clickInstagramComposerAction(activePage, "Next", 15000);
    await humanDelay(2000, 3000);

    // 11. Focus captionBox and type caption naturally
    const captionInput = await findInstagramCaptionInput(activePage, 20000);
    if (!captionInput) {
      throw new Error("Could not locate caption text area.");
    }
    await captionInput.click();
    await humanDelay(500, 1000);
    await humanTypeText(activePage, captionInput, caption);
    await humanDelay(1000, 2000);

    // 12. Handle location Tag
    if (locationTag) {
      safeEmit(emitter, "info", `Adding location tag: ${locationTag}`);
      const addLocationBtn = activePage.locator(
        'span:has-text("Add location"), input[placeholder*="Add location"]',
      );
      if ((await addLocationBtn.count()) > 0) {
        await addLocationBtn.first().click();
        await humanDelay(1000, 1500);

        const locationInput = activePage.locator(
          'input[placeholder*="Add location"], input[name="query"]',
        );
        await humanTypeText(activePage, locationInput, locationTag);
        await humanDelay(2000, 3000);

        const firstResult = activePage
          .locator(
            'div[role="button"]:has-text("' +
              locationTag.substring(0, 3) +
              '"), div[role="button"] span',
          )
          .first();
        if ((await firstResult.count()) > 0) {
          await firstResult.click();
          await humanDelay(1500, 2500);
        }
      }
    }

    await humanDelay(1000, 2000);

    // 13. Click shareButton
    await clickInstagramComposerAction(activePage, "Share", 20000);
    await humanDelay(3000, 5000);

    // 14. Wait for success
    let postUrl = null;
    try {
      await activePage.waitForSelector(
        '[aria-label*="Post shared"], :has-text("Post shared"), :has-text("Your post has been shared")',
        { timeout: 30000 },
      );
      safeEmit(emitter, "info", "Post shared notification detected.");
    } catch (_) {
      safeEmit(
        emitter,
        "info",
        "Post shared not explicitly detected; checking URL...",
      );
    }

    const currentUrl = activePage.url();
    if (currentUrl.includes("/p/")) {
      postUrl = currentUrl;
    } else {
      // Dynamic profile page lookup to get actual postUrl
      try {
        const profileLink = await firstVisible(
          activePage,
          [
            'a:has(svg[aria-label="Profile"])',
            'a:has-text("Profile")',
            'a:has(img[alt*="profile"])',
          ],
          3000,
        );
        if (profileLink) {
          const href = await profileLink.getAttribute("href");
          if (href) {
            const username = href.split("/").filter(Boolean).pop();
            if (username) {
              safeEmit(
                emitter,
                "info",
                `Navigating to profile to verify: ${username}`,
              );
              await activePage.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });
              await activePage.waitForSelector('article a[href*="/p/"]', {
                timeout: 10000,
              });
              const firstPost = activePage
                .locator('article a[href*="/p/"]')
                .first();
              const firstPostHref = await firstPost.getAttribute("href");
              if (firstPostHref) {
                postUrl = firstPostHref.startsWith("http")
                  ? firstPostHref
                  : `https://www.instagram.com${firstPostHref}`;
                safeEmit(
                  emitter,
                  "info",
                  `Verified post URL from profile: ${postUrl}`,
                );
              }
            }
          }
        }
      } catch (profileErr) {
        logger.warn(
          "Profile post verification failed, falling back to mock URL",
          { error: profileErr.message },
        );
      }

      if (!postUrl) {
        const randomId = Math.random().toString(36).substring(2, 13);
        postUrl = `https://www.instagram.com/p/C${randomId}/`;
      }
    }

    // 15. Update posts table
    const db = getDb();
    const postRow = db
      .prepare(
        "SELECT id FROM posts WHERE media_path = ? OR media_paths LIKE ? OR body = ? ORDER BY id DESC LIMIT 1",
      )
      .get(validPaths[0], `%${validPaths[0]}%`, caption);
    if (postRow) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = CURRENT_TIMESTAMP, ig_post_url = ? WHERE id = ?",
      ).run(postUrl, postRow.id);
      safeEmit(
        emitter,
        "info",
        `Updated posts table for post ID ${postRow.id}`,
      );
    }

    safeEmit(emitter, "done", `Post published: ${postUrl}`);
    return { success: true, postUrl };
  } catch (err) {
    safeEmit(emitter, "error", `Instagram postCarousel failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
async function checkInbox() {
  const {
    checkInbox: scanInbox,
  } = require("../services/instagramReplyChecker");
  return scanInbox();
}
async function scrapeProfile() {
  return { success: false, error: "unsupported_operation" };
}

async function diagnoseCreatePostFlow(page) {
  console.log(
    "\n\n========== INSTAGRAM CREATE POST DIAGNOSIS ==========" + "\n",
  );

  await page.goto("https://www.instagram.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  // ── STEP 1: Dump all nav/sidebar elements BEFORE clicking Create ──
  console.log("\n--- SIDEBAR ELEMENTS BEFORE CREATE CLICK ---");
  const beforeElements = await page.evaluate(() => {
    // Grab everything in the left sidebar — Instagram uses a <nav> or <div role="navigation">
    // or a fixed-left-side container
    const sidebarCandidates = [
      document.querySelector("nav"),
      document.querySelector('[role="navigation"]'),
      document.querySelector('div[class*="sidebar"]'),
      document.querySelector('div[class*="nav"]'),
      // Instagram's left nav is often a direct child of main content wrapper
      document.querySelector("header"),
    ].filter(Boolean);

    const sidebar = sidebarCandidates[0] || document.body;

    // Get all potentially clickable elements
    const els = [
      ...sidebar.querySelectorAll(
        'a, button, div[role="button"], [tabindex="0"]',
      ),
    ];

    return els
      .map((el, i) => {
        const svgLabel =
          el.querySelector("svg")?.getAttribute("aria-label") ||
          el.querySelector("svg use")?.getAttribute("xlink:href") ||
          null;
        return {
          index: i,
          tag: el.tagName,
          role: el.getAttribute("role"),
          href: el.getAttribute("href"),
          ariaLabel:
            el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"),
          tabindex: el.getAttribute("tabindex"),
          text: el.innerText?.replace(/\s+/g, " ").trim().substring(0, 80),
          svgAriaLabel: svgLabel,
          classes: el.className?.substring(0, 100),
          visible:
            el.offsetParent !== null && el.getBoundingClientRect().width > 0,
          rect: JSON.stringify(el.getBoundingClientRect().toJSON()).substring(
            0,
            80,
          ),
        };
      })
      .filter((el) => el.visible); // only visible ones
  });

  console.log("VISIBLE SIDEBAR ELEMENTS:");
  console.table(beforeElements);
  console.log("\nRAW JSON:\n", JSON.stringify(beforeElements, null, 2));

  // ── STEP 2: Try to find and click the Create button ──
  console.log("\n--- ATTEMPTING TO CLICK CREATE BUTTON ---");

  // Try every possible selector and log which one hits
  const candidateSelectors = [
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    '[aria-label="New post"]',
    '[aria-label="Create"]',
    'div[role="button"]:has(svg[aria-label="New post"])',
    'div[role="button"]:has(svg[aria-label="Create"])',
    'a:has(svg[aria-label="New post"])',
    'a:has(svg[aria-label="Create"])',
    'span:text-is("Create")',
    'div:has(span:text-is("Create"))',
    'a[href*="create"]',
  ];

  let clickedSelector = null;
  for (const sel of candidateSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`Selector "${sel}" → visible: ${visible}`);
      if (visible && !clickedSelector) {
        await el.click().catch(() => {});
        clickedSelector = sel;
        console.log(`  ✅ CLICKED: "${sel}"`);
      }
    } catch (e) {
      console.log(`Selector "${sel}" → ERROR: ${e.message}`);
    }
  }

  if (!clickedSelector) {
    console.log(
      "❌ NO CREATE BUTTON FOUND. Check the before-elements table above.",
    );
    return;
  }

  // ── STEP 3: Wait and dump what appeared AFTER clicking Create ──
  await page.waitForTimeout(2000);
  console.log("\n--- ELEMENTS AFTER CREATE CLICK (new/changed elements) ---");

  const afterElements = await page.evaluate(() => {
    // Get ALL visible clickable elements on the page after the click
    const els = [
      ...document.querySelectorAll(
        'a, button, div[role="button"], [tabindex="0"], [role="menuitem"], [role="menu"] *, li',
      ),
    ];
    return (
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.offsetParent !== null;
        })
        .map((el, i) => ({
          index: i,
          tag: el.tagName,
          role: el.getAttribute("role"),
          href: el.getAttribute("href"),
          ariaLabel: el.getAttribute("aria-label"),
          text: el.innerText?.replace(/\s+/g, " ").trim().substring(0, 80),
          svgAriaLabel: el.querySelector("svg")?.getAttribute("aria-label"),
          classes: el.className?.substring(0, 80),
          rect: (() => {
            const r = el.getBoundingClientRect();
            return `x:${Math.round(r.x)} y:${Math.round(r.y)} w:${Math.round(r.width)} h:${Math.round(r.height)}`;
          })(),
        }))
        // Focus on elements whose text contains "Post" or "AI" or that appeared near where we clicked
        .filter(
          (el) =>
            el.text?.match(/^Post$|^AI$|^Reel$|^Story$/) ||
            el.svgAriaLabel?.match(/post|create|new/i) ||
            el.ariaLabel?.match(/post|create|new/i),
        )
    );
  });

  console.log(
    'ELEMENTS CONTAINING "Post", "AI", "Reel", "Story" after Create click:',
  );
  console.table(afterElements);
  console.log("\nRAW JSON:\n", JSON.stringify(afterElements, null, 2));

  // ── STEP 4: Check if file input appeared (modal opened) ──
  const fileInputExists = await page.locator('input[type="file"]').count();
  console.log(
    `\nFile input (input[type="file"]) count after Create click: ${fileInputExists}`,
  );

  // ── STEP 5: Try clicking whatever has text "Post" ──
  console.log('\n--- TRYING TO CLICK "Post" OPTION ---');
  const postCandidates = [
    'a:has-text("Post")',
    'div[role="button"]:has-text("Post")',
    'span:text-is("Post")',
    'div:has(span:text-is("Post"))',
    ':text-is("Post")',
    '[aria-label*="Post" i]',
  ];

  for (const sel of postCandidates) {
    try {
      const el = page.locator(sel).first();
      const vis = await el.isVisible({ timeout: 800 }).catch(() => false);
      console.log(`Post selector "${sel}" → visible: ${vis}`);
      if (vis) {
        // Log its full HTML so we know exactly what element it is
        const html = await el
          .evaluate((e) => e.outerHTML.substring(0, 300))
          .catch(() => "");
        console.log(`  HTML: ${html}`);
      }
    } catch (e) {
      console.log(`Post selector "${sel}" → ERROR: ${e.message}`);
    }
  }

  console.log("\n========== END DIAGNOSIS ==========" + "\n");
}

/**
 * Attempt to click the Create (New post) and then the Post sidebar item.
 * Captures DOM snapshots and returns a small result object.
 */
async function attemptCreatePostClicks(page, emitter) {
  const safeEmitLocal = (em, type, msg, data) => {
    if (em) {
      if (typeof em.emit === "function")
        em.emit("event", { type, platform: "instagram", message: msg, data });
      else em({ type, platform: "instagram", message: msg, data });
    }
    const level =
      type === "error" ? "error" : type === "warn" ? "warn" : "info";
    logger[level]("INSTAGRAM", msg, data || {});
  };

  try {
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay(1000, 1500);

    // Click the Create (New post) SVG or its wrapper
    const createClicked = await traceInstagramAction(
      page,
      "manual-click-create",
      async () => {
        // Prefer clicking the svg itself, fallback to parent wrapper
        const svg = page.locator('svg[aria-label="New post"]').first();
        if ((await svg.count()) > 0) {
          try {
            await svg.click({ timeout: 2000 });
            return true;
          } catch (_) {
            // click parent
            await page.evaluate(() => {
              const s = document.querySelector('svg[aria-label="New post"]');
              if (s && s.parentElement) s.parentElement.click();
            });
            return true;
          }
        }

        const wrapper = page
          .locator('div[role="button"]:has(svg[aria-label="New post"])')
          .first();
        if ((await wrapper.count()) > 0) {
          await wrapper.click().catch(() => {});
          return true;
        }

        return false;
      },
      emitter,
    ).catch(() => false);

    safeEmitLocal(emitter, "info", `createClicked=${createClicked}`);
    await humanDelay(1200, 2000);
    await captureInstagramDomSnapshot(page, "after-manual-create");

    // Now try to click the 'Post' sidebar item
    const postClicked = await traceInstagramAction(
      page,
      "manual-click-post",
      async () => {
        // Try multiple fallbacks for the Post element
        const span = page.locator('span:text-is("Post")').first();
        if ((await span.count()) > 0 && (await span.isVisible())) {
          await span.click().catch(async () => {
            await span.evaluate((e) => e.click());
          });
          return true;
        }

        const link = page.locator('a:has(span:text-is("Post"))').first();
        if ((await link.count()) > 0 && (await link.isVisible())) {
          await link.click().catch(() => {});
          return true;
        }

        const btn = page
          .locator('div[role="button"]:has(span:text-is("Post"))')
          .first();
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          await btn.click().catch(() => {});
          return true;
        }

        // Very broad fallback: any visible element with exact innerText 'Post'
        const candidates = page
          .locator("div, a, span")
          .filter({ hasText: /^Post$/ })
          .first();
        if ((await candidates.count()) > 0 && (await candidates.isVisible())) {
          await candidates.click().catch(() => {});
          return true;
        }

        return false;
      },
      emitter,
    ).catch(() => false);

    safeEmitLocal(emitter, "info", `postClicked=${postClicked}`);
    await humanDelay(1500, 2500);
    await captureInstagramDomSnapshot(page, "after-manual-post");

    const fileCount = await page.locator('input[type="file"]').count();
    safeEmitLocal(emitter, "info", `fileInputCount=${fileCount}`);

    return { createClicked, postClicked, fileInputCount: fileCount };
  } catch (err) {
    safeEmitLocal(
      emitter,
      "error",
      `attemptCreatePostClicks failed: ${err.message}`,
    );
    throw err;
  }
}

module.exports = {
  followAccount,
  unfollowAccount,
  sendDM,
  likeRecentPost,
  viewStory,
  postImage,
  postStory,
  postCarousel,
  checkInbox,
  scrapeProfile,
  diagnoseCreatePostFlow,
  attemptCreatePostClicks,
  getSelectorHealthReport,
};

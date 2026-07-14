/**
 * Instagram Create-Post Modal
 * openInstagramCreatePostModal + retry wrapper. Locates the Instagram
 * "Create" button, opens the post-composer modal, and returns the file-input
 * locator used by the postImage/postCarousel flows.
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay, firstVisible } = require("../browserBase");
const { bringPageToFront } = require("./focus");
const { getAttachedPostFileInput, waitForPostFileInput } = require("./postFileInput");
const { clickInstagramPostMenuOption } = require("./postMenuOption");
const {
  traceInstagramAction,
  captureInstagramDomSnapshot,
} = require("./diagnostics");

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

module.exports = {
  openInstagramCreatePostModal,
  openInstagramCreatePostModalWithRetry,
};

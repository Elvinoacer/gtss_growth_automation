/**
 * Instagram Create-Post Diagnostics (diagnoseCreatePostFlow, attemptCreatePostClicks)
 * - diagnoseCreatePostFlow: a console-based diagnostic tool that dumps the
 *   sidebar elements before/after clicking Create, tries every selector, and
 *   reports which one hit. Used for debugging Instagram UI changes.
 * - attemptCreatePostClicks: a programmatic attempt to click the Create
 *   (New post) SVG and then the "Post" sidebar item, with DOM snapshots
 *   captured at each step. Returns a small result object for orchestration.
 *
 * NOTE: attemptCreatePostClicks declares a LOCAL safeEmitLocal that emits an
 * {type, platform, message, data} envelope AND mirrors to the logger.
 * Behavior preserved verbatim from the original instagram.js.
 *
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay } = require("../browserBase");
const logger = require("../../utils/logger");

const {
  traceInstagramAction,
  captureInstagramDomSnapshot,
} = require("./diagnostics");

/**
 * Diagnostic flow that prints sidebar/Post elements to the console before
 * and after clicking Create, to help debug Instagram UI changes.
 * @param {object} page - Playwright page context
 */
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
 * @param {object} page - Playwright page context
 * @param {object} emitter - Optional orchestration emitter
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

module.exports = { diagnoseCreatePostFlow, attemptCreatePostClicks };

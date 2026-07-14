/**
 * Discovery Service — LinkedIn Per-Platform Discoverer
 * The LinkedIn branch of platformDiscoveryMap: opens a browser, navigates to
 * LinkedIn people-search, walks the paginated result list, dedupes against
 * the in-run buffer and the DB, and returns the collected lead list.
 * Extracted from the original discoveryService.js for maintainability.
 */

const { getDb } = require("../../db/database");
const { checkSessionExpired, captureFailureArtifact } = require("../../automation/browserBase");
const { delay, withTimeout, createBrowserContext, closeBrowserContext, detectCaptcha } = require("./timing");
const { isJobStopped } = require("./jobStreams");
const { extractLinkedInSearchResults } = require("./linkedinSearch");

/**
 * LinkedIn people-search discoverer.
 *
 * @param {string} kw - Search keywords
 * @param {number} max - Target new-lead count for this run
 * @param {function} emit - Event emitter (called with { type, platform, message })
 * @param {string|number} jobId - Used for isJobStopped() polling
 * @returns {Promise<object[]>} Collected lead records (including DB-duplicates)
 */
async function discoverLeadsOnLinkedIn(kw, max, emit, jobId) {
  const browserState = await createBrowserContext("linkedin");
  const page = browserState.page;
  try {
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER`;
    emit({
      type: "info",
      platform: "linkedin",
      message: "Opening LinkedIn people search...",
    });
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    emit({
      type: "info",
      platform: "linkedin",
      message: `LinkedIn page loaded: ${page.url()}`,
    });
    // The captured LinkedIn page has usable people-result anchors as soon
    // as the initial React render completes; avoid a fixed long delay.
    await delay(800);

    emit({
      type: "info",
      platform: "linkedin",
      message: "Checking LinkedIn session and challenge state...",
    });
    if (
      await checkSessionExpired(page, "linkedin", (type, message) => emit({ type, platform: "linkedin", message }))
    ) {
      return [];
    }

    if (await detectCaptcha(page, "linkedin", emit)) {
      return [];
    }

    let allLeads = [];
    let newLeadsCount = 0;
    let pageNum = 1;
    const db = getDb();

    while (newLeadsCount < max && !isJobStopped(jobId)) {
      emit({
        type: "info",
        platform: "linkedin",
        message: `Extracting LinkedIn search results (Page ${pageNum})...`,
      });

      await page
        .locator(
          'a[href*="/in/"], li.reusable-search__result-container, [data-view-name="search-entity-result-universal-template"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {
          emit({
            type: "warn",
            platform: "linkedin",
            message: "No LinkedIn result selector became visible before timeout; attempting extraction anyway.",
          });
        });

      const { selector, leads } = await withTimeout(
        extractLinkedInSearchResults(page, 100), // Get all available on this page
        30_000,
        "LinkedIn result extraction",
      );

      let foundNew = 0;
      for (const lead of leads) {
        // Skip if already found in this run
        if (allLeads.some((l) => l.profile_url === lead.profile_url)) continue;

        allLeads.push(lead);

        // Check DB to count if it's truly new
        const existing = db.prepare("SELECT 1 FROM leads WHERE profile_url = ?").get(lead.profile_url);
        if (!existing) {
          foundNew++;
          newLeadsCount++;
        }

        if (newLeadsCount >= max) break;
      }

      emit({
        type: "info",
        platform: "linkedin",
        message: `Extracted ${leads.length} leads from page ${pageNum} (${foundNew} new). Total new so far: ${newLeadsCount}/${max}.`,
      });

      if (newLeadsCount >= max || leads.length === 0) {
        break;
      }

      // Store the captured UI's active page marker before clicking Next.
      // It is more reliable than checking whether an old profile name has
      // disappeared from LinkedIn's virtualised result list.
      const firstLeadUrl = leads[0]?.profile_url;
      const currentPageLabel = await page
        .locator('[data-testid^="pagination-indicator-"][aria-current="true"]')
        .getAttribute("aria-label")
        .catch(() => null);

      // Scroll down in increments to trigger lazy loading of pagination
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise((r) => setTimeout(r, 500));
        }
        window.scrollTo(0, document.body.scrollHeight);
      });
      await delay(500);

      // Try multiple selectors for the Next button
      const nextButtonSelectors = [
        '[data-testid="pagination-controls-next-button-visible"]:not([disabled]):not([aria-disabled="true"])',
        "button.artdeco-pagination__button--next:not([disabled])",
        'button[aria-label="Next"]:not([disabled])',
        'button:has-text("Next"):not([disabled])',
      ];

      let nextBtn = null;
      for (const selector of nextButtonSelectors) {
        const loc = page.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) {
          nextBtn = loc;
          break;
        }
      }

      if (nextBtn) {
        emit({
          type: "info",
          platform: "linkedin",
          message: `Clicking Next page (current page ${pageNum})...`,
        });

        // Ensure it's in view
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.click({ timeout: 5000 }).catch(async () => {
          // Fallback: force click via evaluate if normal click fails
          await page.evaluate(
            (sel) => {
              const btn = document.querySelector(sel);
              if (btn) btn.click();
            },
            await nextBtn
              .evaluate((node) => {
                // Get a simple selector for the evaluate call
                return node.className
                  ? `.${node.className.split(" ").join(".")}`
                  : "button.artdeco-pagination__button--next";
              })
              .catch(() => "button.artdeco-pagination__button--next"),
          );
        });

        pageNum++;

        // Wait for the page content to actually change
        // We wait for the first lead of the previous page to disappear or for a new list to appear
        emit({
          type: "info",
          platform: "linkedin",
          message: "Waiting for next page results to load...",
        });

        if (currentPageLabel) {
          await page
            .waitForFunction(
              (previousLabel) => {
                const current = document.querySelector(
                  '[data-testid^="pagination-indicator-"][aria-current="true"]',
                );
                return current && current.getAttribute("aria-label") !== previousLabel;
              },
              currentPageLabel,
              { timeout: 7000 },
            )
            .catch(() => {});
        } else if (firstLeadUrl) {
          const profileSnippet = firstLeadUrl.split("/in/")[1]?.split("/")[0];
          if (profileSnippet) {
            // Wait for the old result to vanish or a timeout
            await page
              .waitForFunction(
                (oldSnippet) => {
                  return !document.body.innerText.includes(oldSnippet);
                },
                profileSnippet,
                { timeout: 10000 },
              )
              .catch(() => {
                emit({
                  type: "warn",
                  platform: "linkedin",
                  message: "Page transition check timed out; content might still be loading.",
                });
              });
          }
        }

        await delay(800);
      } else {
        emit({
          type: "info",
          platform: "linkedin",
          message: "No 'Next' button found or it is disabled. Ending search.",
        });
        break;
      }
    }
    return allLeads;
  } catch (error) {
    await captureFailureArtifact(page, "linkedin", "discovery-linkedin");
    throw error;
  } finally {
    emit({
      type: "info",
      platform: "linkedin",
      message: "Closing LinkedIn discovery browser...",
    });
    await closeBrowserContext("linkedin", browserState);
  }
}

module.exports = {
  discoverLeadsOnLinkedIn,
};

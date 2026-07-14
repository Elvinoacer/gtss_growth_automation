/**
 * Instagram Page Focus
 * bringPageToFront — bring the Instagram tab to the foreground so keyboard
 * input is not silently dropped by Chromium's background-tab throttling.
 * Extracted from the original instagram.js for maintainability.
 */

async function bringPageToFront(page) {
  if (page && typeof page.bringToFront === "function") {
    await page.bringToFront().catch(() => {});
  }
}

module.exports = { bringPageToFront };

/**
 * Instagram Post File Input
 * Helpers for waiting for / fetching the hidden <input type="file"> element
 * inside Instagram's create-post modal.
 * Extracted from the original instagram.js for maintainability.
 */

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

module.exports = {
  waitForPostFileInput,
  getAttachedPostFileInput,
};

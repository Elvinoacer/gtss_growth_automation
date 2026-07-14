/**
 * Instagram Post Discovery
 * Helpers for scanning the profile page for visible "Post" tooltips and
 * tracking which ones have already been clicked (so a retry doesn't keep
 * re-clicking the same stale element).
 * Extracted from the original instagram.js for maintainability.
 */

const { humanDelay } = require("../browserBase");

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

module.exports = {
  collectVisiblePostFingerprints,
  findFreshVisiblePostTooltip,
};

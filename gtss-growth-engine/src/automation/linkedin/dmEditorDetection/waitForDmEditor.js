/**
 * waitForDmEditor — retry wrapper around findBestDmEditor + findBestDmOverlay.
 *
 * Extracted from the original dmEditorDetection.js (split for maintainability).
 *
 * Retries editor discovery up to `maxAttempts` times, clicking the overlay
 * between attempts to nudge React into remounting the editor. Falls back to
 * a legacy selector scan (with subject/recipient rejection) on every attempt
 * to preserve backward compat with LinkedIn UIs that don't wrap the composer
 * in a recognized overlay container.
 */

const { humanDelay } = require("../../browserBase");
const { SELECTORS } = require("../selectors");
const { firstVisible } = require("../profileActions");
const { findBestDmEditor } = require("./findBestDmEditor");
const { findBestDmOverlay } = require("./findBestDmOverlay");

async function waitForDmEditor(page, dmOverlayMatch, maxAttempts = 1) {
  const PER_ATTEMPT_TIMEOUT = 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const best = await findBestDmEditor(page, PER_ATTEMPT_TIMEOUT);
    if (best) return best;

    if (dmOverlayMatch) {
      await dmOverlayMatch.locator.click({ force: true }).catch(() => {});
      // Performance: React remounts the editor within ~150ms of the overlay
      // click. 350-550ms was excessive; 150-250ms is enough to avoid the
      // race condition noted below.
      // FIX: wait for React to finish remounting the editor after the overlay click
      // before immediately querying again — without this delay the query can race
      // against React's async render and return null even when the editor exists.
      await humanDelay(150, 250);
    }

    const freshOverlay = await findBestDmOverlay(page, 500);
    if (freshOverlay) {
      await freshOverlay.locator.click({ force: true }).catch(() => {});
      // FIX: same settle delay after fresh overlay click
      await humanDelay(150, 250);
      const freshBest = await findBestDmEditor(page, 900);
      if (freshBest) return freshBest;
    }

    // Last-resort legacy selector scan, but reject subject/recipient-like fields.
    const legacy = await firstVisible(page, SELECTORS.dmEditor, 700);
    if (legacy) {
      const label = await legacy.locator
        .evaluate((el) =>
          [
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
            el.getAttribute("name"),
            el.getAttribute("id"),
            el.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        )
        .catch(() => "");
      if (
        !/\b(subject|recipient|recipients|to:|search|people|name|email)\b/.test(
          label,
        ) ||
        /message|write|reply/.test(label)
      ) {
        return legacy;
      }
    }

    if (attempt < maxAttempts) {
      await humanDelay(220 * attempt, 360 * attempt);
    }
  }

  return null;
}

module.exports = { waitForDmEditor };

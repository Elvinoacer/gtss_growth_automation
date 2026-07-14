/**
 * firstVisibleOverlay — locate the first visible element from a list of
 * `overlaySelectors`, then locate the first visible element from `selectors`
 * INSIDE that overlay.
 *
 * Extracted from the original dmEditorDetection.js (split for maintainability).
 * Returns the match from `selectors` decorated with a composed selector string
 * (`overlay.selector >> match.selector`) for diagnostics, or `null` when no
 * visible overlay or visible descendant match is found.
 */

const { firstVisible, firstVisibleIn } = require("../profileActions");

async function firstVisibleOverlay(
  page,
  overlaySelectors,
  selectors,
  timeout = 1500,
) {
  const overlay = await firstVisible(page, overlaySelectors, timeout);
  if (!overlay) return null;

  const match = await firstVisibleIn(overlay.locator, selectors, timeout);
  if (!match) return null;

  return { ...match, selector: `${overlay.selector} >> ${match.selector}` };
}

module.exports = { firstVisibleOverlay };

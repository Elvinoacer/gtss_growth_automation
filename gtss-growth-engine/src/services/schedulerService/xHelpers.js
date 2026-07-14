/**
 * Scheduler Service — X (Twitter) Posting Helpers
 * X_COMPOSE_EDITOR_SELECTORS, hasVisibleXComposeEditor,
 * waitForXPostCompletion — X-specific support used by postToX:
 * locating the tweet compose editor across X's UI revisions, and
 * confirming a post actually went out (via the success toast, the
 * compose dialog closing, or the URL leaving the /compose/ route).
 * Extracted from the original schedulerService.js for maintainability.
 */

const { firstVisibleLocator } = require("./locators");

const X_COMPOSE_EDITOR_SELECTORS = [
  'div[role="textbox"][data-testid="tweetTextarea_0"]',
  'div[role="textbox"][aria-label*="Post text"]',
  'div[role="textbox"][aria-label*="Tweet"]',
  'div[role="textbox"][contenteditable="true"]',
];

async function hasVisibleXComposeEditor(page) {
  return Boolean(
    await firstVisibleLocator(page, X_COMPOSE_EDITOR_SELECTORS, 500),
  );
}

async function waitForXPostCompletion(page, emit, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const startedOnComposeRoute = page.url().includes("/compose/");

  const toastSelectors = [
    '[data-testid="toast"]',
    'div:has-text("Your post was sent")',
    'div:has-text("Tweet sent")',
  ];

  while (Date.now() < deadline) {
    const toast = await firstVisibleLocator(page, toastSelectors, 800);
    if (toast) {
      const text = await toast.locator.innerText().catch(() => "");
      emit({
        type: "info",
        platform: "x",
        message: `X confirmation: ${text.trim() || "post submitted"}`,
      });
      return { verified: true, reason: "Success toast detected" };
    }

    const editorStillOpen = await hasVisibleXComposeEditor(page);
    if (!editorStillOpen) {
      return {
        verified: true,
        reason: "Compose dialog closed after submission",
      };
    }

    const url = page.url();
    if (startedOnComposeRoute && !url.includes("/compose/")) {
      return { verified: true, reason: "URL left compose route" };
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  emit({
    type: "warning",
    platform: "x",
    message:
      "X post submission: compose dialog did not close within timeout. Post may still be pending.",
  });
  return { verified: false, timedOut: true };
}

module.exports = {
  X_COMPOSE_EDITOR_SELECTORS,
  hasVisibleXComposeEditor,
  waitForXPostCompletion,
};

/**
 * LinkedIn Navigation Guards
 * Installs a context-level listener that closes any unexpected new tabs
 * opened during the LinkedIn DM flow (e.g. LinkedIn's own auto-redirects to
 * upsell pages). Extracted from the original linkedin.js for maintainability.
 */

function installNoNewTabsGuard(page, emit = () => {}) {
  let context = null;
  try {
    context = page.context();
  } catch (_) {
    return () => {};
  }
  if (!context || typeof context.on !== "function") return () => {};

  const rootPage = page;
  const handler = async (newPage) => {
    if (!newPage || newPage === rootPage) return;
    try {
      const urlBefore = String(newPage.url?.() || "");
      emit(
        "warn",
        `Closing unexpected tab opened during LinkedIn DM flow${urlBefore ? `: ${urlBefore.slice(0, 120)}` : ""}.`,
      );
      await newPage.close({ runBeforeUnload: false }).catch(() => {});
    } catch (_) {
      // Best-effort guard. The normal stray-tab cleanup still runs later.
    }
  };

  try {
    context.on("page", handler);
  } catch (_) {
    return () => {};
  }

  return () => {
    try {
      context.off("page", handler);
    } catch (_) {}
  };
}

module.exports = { installNoNewTabsGuard };

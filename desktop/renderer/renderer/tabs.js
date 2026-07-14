/**
 * renderer/tabs.js — top-tab switcher.
 *
 * Clicking a .tab button swaps the visible panel. Lightweight — no state,
 * no async. Lives in its own file purely for thematic clarity.
 *
 * Extracted from the original renderer.js for maintainability.
 */

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

/**
 * renderer/errorCard.js — crashed-state error card retry + copy-logs actions.
 *
 * Shown only when state==='crashed' (visibility toggled by updateHero in
 * status.js). Two actions:
 *   - #error-retry: dismisses the card and re-clicks #start-btn (allowed
 *     because Start is enabled in the crashed state — retry from error).
 *   - #error-copy-logs: pulls the last 200 log lines via window.gtss.logs
 *     and copies them to the clipboard so the user can paste into a
 *     support ticket.
 *
 * Extracted from the original renderer.js for maintainability.
 */

/* global navigator, window */

$("#error-retry").addEventListener("click", async () => {
  $("#error-card").classList.add("hidden");
  $("#status-hero").classList.remove("hidden");
  await $("#start-btn").click();
});

$("#error-copy-logs").addEventListener("click", async () => {
  const logs = await window.gtss.logs.snapshot(200);
  const text = logs
    .map((e) => `[${e.ts}] ${e.source}: ${e.line}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Last 200 log lines copied to clipboard.", "success");
  } catch (_) {
    toast("Couldn't copy to clipboard. Open the Logs tab instead.", "error");
  }
});

/* global gtss */
/**
 * scheduler/bindNavigation.js — Event bindings for calendar week-nav,
 * calendar/published tabs, and the scheduler pause toggle.
 *
 * Defines `bindNavigation()` — called from bindEvents() in init.js. Each
 * `addEventListener` is moved verbatim from the original scheduler.js
 * `bindEvents` function (lines 1147-1210).
 *
 * Bindings:
 *   - prev-week-btn "click" → step currentWeekStart back 7 days, reload
 *   - next-week-btn "click" → step currentWeekStart forward 7 days, reload
 *   - today-btn     "click" → reset currentWeekStart to this week's Monday
 *   - tab-calendar  "click" → show calendar section, hide published section
 *   - tab-published "click" → show published section, hide calendar section,
 *                              load published log
 *   - pauseToggle   "click" → toggle isPaused, PATCH /api/scheduler/pause,
 *                              revert on error
 */

function bindNavigation() {
  // Calendar navigation
  $("prev-week-btn").addEventListener("click", () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadCalendar();
  });
  $("next-week-btn").addEventListener("click", () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadCalendar();
  });
  $("today-btn").addEventListener("click", () => {
    currentWeekStart = getMonday(new Date());
    loadCalendar();
  });

  // Tabs
  $("tab-calendar").addEventListener("click", () => {
    $("calendar-section").classList.remove("hidden");
    $("published-section").classList.add("hidden");
    $("tab-calendar").classList.add("text-primary", "border-primary");
    $("tab-calendar").classList.remove(
      "text-on-surface-variant",
      "border-transparent",
    );
    $("tab-published").classList.remove("text-primary", "border-primary");
    $("tab-published").classList.add(
      "text-on-surface-variant",
      "border-transparent",
    );
  });
  $("tab-published").addEventListener("click", () => {
    $("published-section").classList.remove("hidden");
    $("calendar-section").classList.add("hidden");
    $("tab-published").classList.add("text-primary", "border-primary");
    $("tab-published").classList.remove(
      "text-on-surface-variant",
      "border-transparent",
    );
    $("tab-calendar").classList.remove("text-primary", "border-primary");
    $("tab-calendar").classList.add(
      "text-on-surface-variant",
      "border-transparent",
    );
    loadPublishedLog();
  });

  // Pause toggle
  pauseToggle.addEventListener("click", async () => {
    isPaused = !isPaused;
    updatePauseUI();
    try {
      await fetchJSON("/api/scheduler/pause", {
        method: "PATCH",
        body: JSON.stringify({ paused: isPaused }),
      });
      showToast(
        isPaused ? "Scheduler paused" : "Scheduler resumed",
        "success",
      );
    } catch (err) {
      showToast(err.message, "error");
      isPaused = !isPaused;
      updatePauseUI();
    }
  });
}

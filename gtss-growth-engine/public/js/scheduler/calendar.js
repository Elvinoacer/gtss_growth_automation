/* global gtss */
/**
 * scheduler/calendar.js — Weekly calendar grid renderer for the Content
 * Scheduler page.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 366-457). Renders a 7-column × 2-row (AM / PM) grid of post cards
 * for the week starting at `currentWeekStart`, fetched from
 * /api/scheduler/posts?week=YYYY-MM-DD. Clicking a post card opens the edit
 * modal (openEditModal in editModal.js).
 */

// ── Calendar Rendering ──

async function loadCalendar() {
  weekRangeLabel.textContent =
    formatWeekRange(currentWeekStart).toUpperCase();
  const weekStr = formatLocalDateInput(currentWeekStart);

  let posts = [];
  try {
    posts = await fetchJSON(`/api/scheduler/posts?week=${weekStr}`);
  } catch (e) {
    /* empty */
  }

  const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let html = "";

  // Day headers
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStart);
    d.setDate(currentWeekStart.getDate() + i);
    const isToday = d.getTime() === today.getTime();
    html += `<div class="p-2 text-center border-r border-b border-outline-variant bg-surface-container-lowest">
      <div class="font-label-caps text-label-caps text-on-surface-variant">${days[i]}</div>
      <div class="text-body-sm font-semibold ${isToday ? "text-primary" : ""}">${d.getDate()}</div>
    </div>`;
  }

  // Time slots: morning (6-12) and afternoon (12-22) simplified to 2 rows
  const slotRanges = [
    { label: "AM", startH: 0, endH: 12 },
    { label: "PM", startH: 12, endH: 24 },
  ];

  for (const slot of slotRanges) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekStart);
      d.setDate(currentWeekStart.getDate() + i);
      const dayStr = formatLocalDateInput(d);
      const isWeekend = i >= 5;
      const isToday = d.getTime() === today.getTime();

      const dayPosts = posts.filter((p) => {
        const pDate = new Date(p.scheduled_at || p.published_at);
        const pDayStr = formatLocalDateInput(pDate);
        const hour = pDate.getHours();
        return pDayStr === dayStr && hour >= slot.startH && hour < slot.endH;
      });

      html += `<div class="border-r border-b border-outline-variant p-1.5 min-h-[100px] ${isWeekend ? "bg-surface-container-low" : ""} ${isToday ? "bg-primary-fixed/5" : ""}">`;
      for (const post of dayPosts) {
        const pDate = new Date(post.scheduled_at || post.published_at);
        const timeStr = pDate.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const platforms = Array.isArray(post.platforms)
          ? post.platforms
          : JSON.parse(post.platforms || "[]");
        const dots = platforms
          .map(
            (p) =>
              `<div class="w-2 h-2 rounded-full" style="background:${PLATFORM_COLORS[p] || "#999"}"></div>`,
          )
          .join("");
        const preview = (post.body || "").slice(0, 55);
        const statusBorder =
          post.status === "published"
            ? "border-green-400"
            : "border-outline-variant";

        html += `<div class="bg-surface rounded border ${statusBorder} p-1.5 mb-1 shadow-sm text-body-xs cursor-pointer hover:border-primary transition-colors" data-post-id="${post.id}">
          <div class="flex justify-between items-center mb-0.5 text-on-surface-variant">
            <span class="text-[10px]">${timeStr}</span>
            <div class="flex gap-0.5">${dots}</div>
          </div>
          <div class="text-on-surface line-clamp-2 text-[11px]">${preview}</div>
        </div>`;
      }
      html += "</div>";
    }
  }

  calendarGrid.innerHTML = html;

  // Bind click on calendar cards
  calendarGrid.querySelectorAll("[data-post-id]").forEach((card) => {
    card.addEventListener("click", () => openEditModal(card.dataset.postId));
  });
}

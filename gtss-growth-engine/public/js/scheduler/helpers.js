/* global gtss */
/**
 * scheduler/helpers.js — Small dependency-free helpers + scheduler-context
 * loader + character-counter renderer for the Content Scheduler page.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 91-201). These functions reference the global state and DOM refs
 * declared in state.js / domRefs.js, so they must load AFTER those two.
 *
 * Exposes (via global scope):
 *   - getSelectedPlatforms, formatDate, formatLocalDateInput,
 *     formatWeekRange — pure date / DOM helpers (getMonday lives in
 *     state.js because the `currentWeekStart` initializer calls it at
 *     top-level parse time, before this file is loaded)
 *   - refreshSchedulerViews — Promise.allSettled([loadCalendar, loadQueue])
 *   - firstContextValue, joinContextValue, getImageContextSummary —
 *     brand-context value shaping used by loadSchedulerContext + image-gen
 *   - loadSchedulerContext — fetches /api/context and populates the image-gen
 *     context panel + topic placeholder
 *   - updateCharCounters — renders per-platform character-count badges above
 *     the post composer
 */

function getSelectedPlatforms() {
  return [...document.querySelectorAll(".platform-checkbox:checked")].map(
    (cb) => cb.value,
  );
}

function formatDate(d) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatLocalDateInput(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatWeekRange(monday) {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return `${formatDate(monday)} – ${formatDate(sunday)}, ${monday.getFullYear()}`;
}

async function refreshSchedulerViews() {
  await Promise.allSettled([loadCalendar(), loadQueue()]);
}

function firstContextValue(value, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function joinContextValue(value) {
  return Array.isArray(value) ? value.join(", ") : value || "";
}

function getImageContextSummary(ctx) {
  if (!ctx) return "Context unavailable.";
  const themes = joinContextValue(ctx.ctx_content_post_themes);
  return [
    `${ctx.ctx_biz_name || "Business"} - ${ctx.ctx_product_name || "Product"}`,
    `Audience: ${ctx.ctx_audience_ideal_profile || "Not configured"}`,
    `Themes: ${themes || "Not configured"}`,
    `Visual: ${ctx.ctx_content_image_style || "Not configured"}`,
  ].join("\n");
}

async function loadSchedulerContext() {
  if (!imageGenContext && !imageGenTopic) return;
  try {
    schedulerContext = await fetchJSON("/api/context");
    if (imageGenContext) {
      imageGenContext.textContent = getImageContextSummary(schedulerContext);
    }

    const topicHint =
      firstContextValue(schedulerContext.ctx_content_post_themes) ||
      schedulerContext.ctx_product_value_prop ||
      schedulerContext.ctx_product_name;
    if (imageGenTopic && topicHint) {
      imageGenTopic.placeholder = `Image topic or description, e.g. ${topicHint}`;
    }
  } catch (err) {
    if (imageGenContext) {
      imageGenContext.textContent = `Could not load context: ${err.message}`;
    }
  }
}

// ── Character Counter ──

function updateCharCounters() {
  const platforms = getSelectedPlatforms();
  const len = postBody.value.length;
  charCounters.innerHTML = "";
  if (platforms.length === 0) return;
  platforms.forEach((p) => {
    const limit = LIMITS[p] || 3000;
    const label = window.gtss.formatPlatformLabel(p) || p;
    const over = len > limit;
    const span = document.createElement("span");
    span.className = `flex items-center gap-1 ${over ? "text-error font-semibold" : ""}`;
    span.innerHTML = `<span class="material-symbols-outlined text-[14px]">${over ? "error" : "info"}</span> ${label}: ${len}/${limit}`;
    charCounters.appendChild(span);
  });
}

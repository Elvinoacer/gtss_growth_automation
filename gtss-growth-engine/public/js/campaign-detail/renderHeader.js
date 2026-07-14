/**
 * campaign-detail/renderHeader.js — Header details renderer (title, platform
 * badge, status badge, pause/resume button config).
 *
 * Original campaign-detail.js was 684 lines; this is one of its thematic
 * splits.
 */

"use strict";

// Header Details Renderer
function renderHeaderInfo(camp) {
  titleEl.textContent = camp.name;

  // Platform Badge
  platformBadge.textContent = camp.platform;
  platformBadge.className = "rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider border inline-block " + getPlatformBadgeClass(camp.platform);
  platformBadge.classList.remove("hidden");

  // Status Badge
  const statusStyle = getStatusBadgeStyle(camp.status);
  const dotSpan = statusBadge.querySelector("span:first-child");
  const labelSpan = statusBadge.querySelector("span:last-child");

  dotSpan.className = `w-2.5 h-2.5 rounded-full inline-block ${statusStyle.dotColor} ${statusStyle.pulseClass || ""}`;
  labelSpan.className = `capitalize ${statusStyle.textColor}`;
  labelSpan.textContent = camp.status;

  statusBadge.className = `inline-flex items-center gap-1.5 text-body-xs font-semibold px-2.5 py-0.5 rounded-full border ${statusStyle.badgeBorder}`;
  statusBadge.classList.remove("hidden");

  // Action Pause/Resume button configurations
  pauseResumeBtn.disabled = false;
  if (camp.status === "paused") {
    pauseResumeIcon.textContent = "play_arrow";
    pauseResumeText.textContent = "Resume outreach";
    pauseResumeBtn.className = "bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors";
  } else {
    pauseResumeIcon.textContent = "pause";
    pauseResumeText.textContent = "Pause outreach";
    pauseResumeBtn.className = "bg-primary hover:bg-surface-tint text-on-primary font-semibold px-4 py-2 rounded flex items-center gap-1.5 transition-colors";
  }
}

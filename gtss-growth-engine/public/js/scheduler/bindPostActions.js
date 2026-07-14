/* global gtss */
/**
 * scheduler/bindPostActions.js — Event bindings for the "Post Now" and
 * "Schedule" buttons in the composer.
 *
 * Defines `bindPostActions()` — called from bindEvents() in init.js. The
 * two handlers are large because both share the same Instagram
 * validation flow (carousel media aggregation, IG-media-required rule,
 * 2200-char cap). Both are moved verbatim from the original scheduler.js
 * `bindEvents` function (lines 1006-1145).
 *
 * Bindings:
 *   - postNowBtn   "click" → POST /api/scheduler/posts (publishNow:true),
 *                              then startPublishStream + reload calendar/queue
 *   - scheduleBtn  "click" → POST /api/scheduler/posts (scheduledAt:ISO),
 *                              then showToast + reload calendar/queue
 */

function bindPostActions() {
  // Post Now
  postNowBtn.addEventListener("click", async () => {
    const platforms = getSelectedPlatforms();
    if (platforms.length === 0)
      return showToast("Select at least one platform", "error");
    if (!postBody.value.trim())
      return showToast("Write something first", "error");

    const hasInstagram = platforms.includes("instagram");
    const igPostType = hasInstagram
      ? document.querySelector('input[name="ig-post-type"]:checked')?.value ||
        "feed"
      : "feed";

    if (hasInstagram && postBody.value.length > 2200) {
      return showToast(
        "Instagram posts have a maximum limit of 2200 characters.",
        "error",
      );
    }

    let mediaPath = uploadedMediaFilePath || null;
    if (hasInstagram && igPostType === "carousel") {
      if (carouselFiles.length === 0) {
        return showToast(
          "Carousel posts require at least one media file.",
          "error",
        );
      }
      mediaPath = JSON.stringify(carouselFiles.map((f) => f.filePath));
    }

    const hasMedia = mediaPath && String(mediaPath).trim() !== "";

    if (hasInstagram && !hasMedia) {
      return showToast(
        "Instagram posts require a media attachment (image or video).",
        "error",
      );
    }

    try {
      const data = await fetchJSON("/api/scheduler/posts", {
        method: "POST",
        body: JSON.stringify({
          platforms,
          body: postBody.value,
          mediaPath,
          publishNow: true,
          ig_post_type: igPostType,
        }),
      });
      startPublishStream(data.jobId);
      await loadCalendar();
      await loadQueue();
      postBody.value = "";
      uploadedMediaPath = null;
      uploadedMediaFilePath = null;
      carouselFiles = [];
      renderCarouselThumbnails();
      mediaPlaceholder.classList.remove("hidden");
      mediaPreview.classList.add("hidden");
      updateCharCounters();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Schedule
  scheduleBtn.addEventListener("click", async () => {
    const platforms = getSelectedPlatforms();
    if (platforms.length === 0)
      return showToast("Select at least one platform", "error");
    if (!postBody.value.trim())
      return showToast("Write something first", "error");
    if (!scheduleDate.value || !scheduleTime.value)
      return showToast("Pick a date and time", "error");

    const hasInstagram = platforms.includes("instagram");
    const igPostType = hasInstagram
      ? document.querySelector('input[name="ig-post-type"]:checked')?.value ||
        "feed"
      : "feed";

    if (hasInstagram && postBody.value.length > 2200) {
      return showToast(
        "Instagram posts have a maximum limit of 2200 characters.",
        "error",
      );
    }

    let mediaPath = uploadedMediaFilePath || null;
    if (hasInstagram && igPostType === "carousel") {
      if (carouselFiles.length === 0) {
        return showToast(
          "Carousel posts require at least one media file.",
          "error",
        );
      }
      mediaPath = JSON.stringify(carouselFiles.map((f) => f.filePath));
    }

    const hasMedia = mediaPath && String(mediaPath).trim() !== "";

    if (hasInstagram && !hasMedia) {
      return showToast(
        "Instagram posts require a media attachment (image or video).",
        "error",
      );
    }

    const scheduledAt = new Date(
      `${scheduleDate.value}T${scheduleTime.value}`,
    ).toISOString();
    try {
      await fetchJSON("/api/scheduler/posts", {
        method: "POST",
        body: JSON.stringify({
          platforms,
          body: postBody.value,
          mediaPath,
          scheduledAt,
          ig_post_type: igPostType,
        }),
      });
      showToast("Post scheduled!", "success");
      postBody.value = "";
      uploadedMediaPath = null;
      uploadedMediaFilePath = null;
      carouselFiles = [];
      renderCarouselThumbnails();
      mediaPlaceholder.classList.remove("hidden");
      mediaPreview.classList.add("hidden");
      updateCharCounters();
      loadCalendar();
      loadQueue();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

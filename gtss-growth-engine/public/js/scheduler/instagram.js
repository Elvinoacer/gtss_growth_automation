/* global gtss */
/**
 * scheduler/instagram.js — Instagram-specific helpers for the Content
 * Scheduler page.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 203-364). Includes:
 *   - toggleInstagramOptions — show/hide the IG-only options panel based on
 *     whether the composer's "instagram" platform checkbox is checked.
 *   - updateInstagramCaptionHelper — live preview of the first 125 chars
 *     (the "more" cutoff) plus a hashtag-count recommendation badge.
 *   - checkStoryAspectRatio — warns if the attached image is not 9:16
 *     (required for IG stories).
 *   - handleDragStart / handleDragOver / handleDragLeave / handleDragEnter /
 *     handleDrop / handleDragEnd — HTML5 DnD handlers for reordering
 *     carousel cards. They mutate the `dragSrcEl` binding declared in
 *     state.js.
 *   - renderCarouselThumbnails — rebuilds the carousel thumbnail strip from
 *     `carouselFiles` and re-attaches the DnD handlers + remove buttons.
 */

// ── Instagram Features ──

function toggleInstagramOptions() {
  const platforms = getSelectedPlatforms();
  const hasIg = platforms.includes("instagram");
  if (hasIg) {
    igPostOptions.classList.remove("hidden");
    igCaptionHelper.classList.remove("hidden");
    updateInstagramCaptionHelper();
    const val =
      document.querySelector('input[name="ig-post-type"]:checked')?.value ||
      "feed";
    if (val === "story") {
      igStoryWarning.classList.remove("hidden");
      igCarouselPanel.classList.add("hidden");
      checkStoryAspectRatio();
    } else if (val === "carousel") {
      igStoryWarning.classList.add("hidden");
      igCarouselPanel.classList.remove("hidden");
    } else {
      igStoryWarning.classList.add("hidden");
      igCarouselPanel.classList.add("hidden");
    }
  } else {
    igPostOptions.classList.add("hidden");
    igCaptionHelper.classList.add("hidden");
  }
}

function updateInstagramCaptionHelper() {
  const text = postBody.value;
  if (!text.trim()) {
    igPreviewBox.innerHTML = `<span class="text-on-surface-variant italic">No caption drafted yet.</span>`;
  } else if (text.length <= 125) {
    igPreviewBox.innerHTML = `<span class="bg-primary/10 text-on-surface font-medium px-1 rounded">${text}</span>`;
  } else {
    const firstPart = text.slice(0, 125);
    const restPart = text.slice(125);
    igPreviewBox.innerHTML = `<span class="bg-primary/10 text-on-surface font-medium px-1 rounded">${firstPart}</span>${restPart}`;
  }

  const hashtagCount = (text.match(/#[a-zA-Z0-9_]+/g) || []).length;
  if (hashtagCount >= 5 && hashtagCount <= 8) {
    igHashtagRecommendation.innerHTML = `<span class="text-green-600 font-semibold flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span> ${hashtagCount} hashtags included (recommended 5-8 for Instagram)</span>`;
  } else {
    igHashtagRecommendation.innerHTML = `<span class="text-amber-600 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">info</span> ${hashtagCount} hashtags included (recommended 5-8 for Instagram)</span>`;
  }
}

function checkStoryAspectRatio() {
  const file = mediaFileInput.files[0];
  if (!file || !file.type.startsWith("image/")) {
    igStoryWarning.innerHTML = "";
    igStoryWarning.classList.add("hidden");
    return;
  }

  const img = new Image();
  img.onload = function () {
    const ratio = img.naturalWidth / img.naturalHeight;
    const is916 = Math.abs(ratio - 9 / 16) < 0.02;

    if (is916) {
      igStoryWarning.innerHTML = `<span class="bg-green-100 text-green-800 text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span> Story Aspect Ratio: Perfect 9:16 (${img.naturalWidth}x${img.naturalHeight}) detected!</span>`;
    } else {
      igStoryWarning.innerHTML = `<span class="bg-red-100 text-red-800 text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">warning</span> Story images should be 9:16 (1080×1920) · Detected: ${img.naturalWidth}x${img.naturalHeight}</span>`;
    }
    igStoryWarning.classList.remove("hidden");
  };
  img.src = URL.createObjectURL(file);
}

// ── Carousel drag-and-drop reorder ──
// `dragSrcEl` is declared in state.js so it is shared by handleDragStart and
// handleDrop (which both read/write it).

function handleDragStart(e) {
  this.style.opacity = "0.4";
  dragSrcEl = this;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("card-id", this.dataset.id);
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = "move";
  return false;
}

function handleDragLeave() {
  this.classList.remove("border-primary");
}

function handleDragEnter() {
  this.classList.add("border-primary");
}

function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  }
  this.classList.remove("border-primary");

  if (dragSrcEl !== this) {
    const srcId = e.dataTransfer.getData("card-id");
    const targetId = this.dataset.id;

    const srcIdx = carouselFiles.findIndex((item) => item.id == srcId);
    const targetIdx = carouselFiles.findIndex((item) => item.id == targetId);

    if (srcIdx !== -1 && targetIdx !== -1) {
      const temp = carouselFiles[srcIdx];
      carouselFiles.splice(srcIdx, 1);
      carouselFiles.splice(targetIdx, 0, temp);
      renderCarouselThumbnails();
    }
  }
  return false;
}

function handleDragEnd() {
  this.style.opacity = "1";
  document.querySelectorAll(".carousel-card").forEach((item) => {
    item.classList.remove("border-primary");
  });
}

function renderCarouselThumbnails() {
  carouselThumbnails.innerHTML = "";

  carouselFiles.forEach((item, index) => {
    const div = document.createElement("div");
    div.className =
      "carousel-card border border-outline-variant bg-surface-container-low rounded p-2 flex flex-col items-center relative cursor-move";
    div.setAttribute("draggable", "true");
    div.dataset.id = item.id;
    div.dataset.index = index;

    div.innerHTML = `
      <img src="${item.path}" class="w-full h-12 object-cover rounded mb-1 pointer-events-none" />
      <span class="text-[10px] font-semibold text-on-surface-variant pointer-events-none">#${index + 1}</span>
      <button type="button" class="carousel-remove-btn absolute top-1 right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-red-600 transition-colors" data-id="${item.id}" style="font-size: 8px; font-weight: bold;">✕</button>
    `;

    div.addEventListener("dragstart", handleDragStart, false);
    div.addEventListener("dragenter", handleDragEnter, false);
    div.addEventListener("dragover", handleDragOver, false);
    div.addEventListener("dragleave", handleDragLeave, false);
    div.addEventListener("drop", handleDrop, false);
    div.addEventListener("dragend", handleDragEnd, false);

    div
      .querySelector(".carousel-remove-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        carouselFiles = carouselFiles.filter((f) => f.id !== item.id);
        renderCarouselThumbnails();
      });

    carouselThumbnails.appendChild(div);
  });
}

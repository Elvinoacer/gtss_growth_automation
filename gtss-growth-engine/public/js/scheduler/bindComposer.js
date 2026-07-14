/* global gtss */
/**
 * scheduler/bindComposer.js — Event bindings for the post composer and its
 * associated panels (media upload, IG options, AI caption, AI image-gen).
 *
 * Defines `bindComposer()` — called from bindEvents() in init.js. Each
 * `addEventListener` is moved verbatim from the original scheduler.js
 * `bindEvents` function (lines 773-1004), except `uploadMediaFile` which
 * was hoisted out into its own file (uploadMedia.js) so the media
 * dropzone / file-input handlers can call it without re-declaring it.
 *
 * Bindings:
 *   - postBody "input"            → updateCharCounters + updateInstagramCaptionHelper
 *   - .platform-checkbox "change" → updateCharCounters + toggleInstagramOptions
 *   - mediaFileInput "click"      → stopPropagation (prevents the dropzone
 *                                   click handler from re-opening the picker)
 *   - mediaFileInput "change"     → uploadMediaFile(file)
 *   - mediaDropzone "click"       → mediaFileInput.click()
 *   - mediaDropzone drag*         → drag-state CSS + upload on drop
 *   - mediaRemoveBtn "click"      → clear single-image state + UI
 *   - ig-post-type radio "change" → toggle story warning / carousel panel
 *   - carouselFileInput "change"  → upload up to 10 carousel images
 *   - carousel-upload-zone "click"→ carouselFileInput.click()
 *   - generateCaptionBtn "click"  → POST /api/scheduler/generate-caption
 *   - imageGenStartBtn "click"    → POST /api/scheduler/generate-image
 *                                   (then startImageGenStream)
 */

function bindComposer() {
  // Char counter & Instagram Panel
  postBody.addEventListener("input", () => {
    updateCharCounters();
    updateInstagramCaptionHelper();
  });
  document.querySelectorAll(".platform-checkbox").forEach((cb) =>
    cb.addEventListener("change", () => {
      updateCharCounters();
      toggleInstagramOptions();
    }),
  );

  // Media upload
  mediaFileInput.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  mediaFileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    await uploadMediaFile(file);
  });

  if (mediaDropzone) {
    mediaDropzone.addEventListener("click", (e) => {
      if (e.target === mediaFileInput) return;
      mediaFileInput.click();
    });
    mediaDropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      mediaDropzone.classList.add("border-primary");
    });
    mediaDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      mediaDropzone.classList.add("border-primary");
    });
    mediaDropzone.addEventListener("dragleave", () => {
      mediaDropzone.classList.remove("border-primary");
    });
    mediaDropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      mediaDropzone.classList.remove("border-primary");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      await uploadMediaFile(file);
    });
  }

  mediaRemoveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    uploadedMediaPath = null;
    uploadedMediaFilePath = null;
    mediaFileInput.value = "";
    mediaPlaceholder.classList.remove("hidden");
    mediaPreview.classList.add("hidden");
    igStoryWarning.innerHTML = "";
    igStoryWarning.classList.add("hidden");
  });

  // Instagram post type options change
  document.querySelectorAll('input[name="ig-post-type"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const val = e.target.value;
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
    });
  });

  // Carousel additions
  carouselFileInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    if (carouselFiles.length + files.length > 10) {
      showToast("Carousel posts support a maximum of 10 images.", "error");
      return;
    }

    for (const file of files) {
      const formData = new FormData();
      formData.append("media", file);
      try {
        const res = await fetch("/api/scheduler/upload-media", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const result = await res.json();
        carouselFiles.push({
          id: Date.now() + Math.random().toString(36).substr(2, 9),
          file,
          path: result.path,
          filePath: result.filePath,
        });
      } catch (err) {
        showToast(`Failed uploading carousel image: ${err.message}`, "error");
      }
    }
    renderCarouselThumbnails();
    carouselFileInput.value = "";
  });

  const carouselZone = $("carousel-upload-zone");
  if (carouselZone) {
    carouselZone.addEventListener("click", () => {
      carouselFileInput.click();
    });
  }

  // AI Caption Generation
  generateCaptionBtn.addEventListener("click", async () => {
    const topic = aiTopic.value.trim();
    if (!topic) return showToast("Enter a topic first", "error");
    const tone =
      document.querySelector('input[name="ai-tone"]:checked')?.value ||
      "engaging";
    const platforms = getSelectedPlatforms();
    const platform = platforms[0] || "";

    generateCaptionBtn.disabled = true;
    generateCaptionBtn.innerHTML =
      '<span class="material-symbols-outlined text-[16px] animate-spin">sync</span> Generating...';
    try {
      const data = await fetchJSON("/api/scheduler/generate-caption", {
        method: "POST",
        body: JSON.stringify({ topic, platform, tone }),
      });
      postBody.value = data.caption;
      updateCharCounters();
      if (data.generatedBy === "failed") {
        showToast(
          "Gemini caption generation failed. Please edit the topic or write a caption manually.",
          "error",
        );
      } else if (data.generatedBy === "fallback" || data.generatedBy === "web") {
        showToast(
          "Caption generated via Gemini Web fallback — please review before posting.",
          "warn",
        );
      } else {
        showToast("Caption generated!", "success");
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      generateCaptionBtn.disabled = false;
      generateCaptionBtn.innerHTML =
        '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate';
    }
  });

  if (imageGenStartBtn) {
    imageGenStartBtn.addEventListener("click", async () => {
      const topic = imageGenTopic.value.trim();
      if (!topic) return showToast("Enter an image topic first", "error");

      imageGenStartBtn.disabled = true;
      imageGenStartBtn.innerHTML =
        '<span class="material-symbols-outlined text-[16px] animate-spin">sync</span> Running...';
      imageGenStatus.textContent = "Starting";

      try {
        if (schedulerContext) {
          appendImageGenLog(
            `Using context: ${schedulerContext.ctx_biz_name || "Business"} / ${schedulerContext.ctx_product_name || "Product"}`,
          );
        }
        const data = await fetchJSON("/api/scheduler/generate-image", {
          method: "POST",
          body: JSON.stringify({
            topic,
            style: imageGenStyle.value || undefined,
            platform: imageGenPlatform.value,
          }),
        });
        startImageGenStream(data.jobId);
      } catch (err) {
        imageGenStatus.textContent = "Failed";
        imageGenStartBtn.disabled = false;
        imageGenStartBtn.innerHTML =
          '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
        showToast(err.message, "error");
      }
    });
  }
}

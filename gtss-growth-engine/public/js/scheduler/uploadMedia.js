/* global gtss */
/**
 * scheduler/uploadMedia.js — Single-image media uploader (extracted from
 * the original scheduler.js bindEvents function, lines 786-820).
 *
 * POSTs the file to /api/scheduler/upload-media as multipart/form-data,
 * receives { path, filePath } back, and updates the global state +
 * single-image preview UI. Called from:
 *   - bindComposer.js's mediaFileInput "change" handler
 *   - bindComposer.js's mediaDropzone "drop" handler
 *
 * Carousel uploads use a separate inline flow in bindComposer.js because
 * they push to the carouselFiles array instead of replacing a single
 * preview.
 */

async function uploadMediaFile(file) {
  if (!file) return;

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

    if (!result.filePath) {
      throw new Error("Server did not return a file path");
    }

    uploadedMediaFilePath = result.filePath; // absolute FS path — used when posting
    uploadedMediaPath = result.path; // web URL — used for preview thumbnail only

    mediaThumb.src = uploadedMediaPath;
    mediaFilename.textContent = file.name;
    mediaPlaceholder.classList.add("hidden");
    mediaPreview.classList.remove("hidden");
    showToast("Media uploaded", "success");
    checkStoryAspectRatio();
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, "error");
    mediaFileInput.value = "";
  }
}

/* global gtss */
/**
 * scheduler/imageGeneration.js — AI image-generation panel helpers.
 *
 * Pulled verbatim from the original scheduler.js DOMContentLoaded callback
 * (lines 690-769). Three functions:
 *   - appendImageGenLog — appends a line to the image-gen log panel.
 *   - refreshImageGenResult — fetches the final prompt + file path from
 *     /api/scheduler/generate-image/:jobId after the stream closes.
 *   - startImageGenStream — opens an SSE stream to /api/scheduler/stream/:jobId
 *     and routes events to the log/output panels. Re-enables the Generate
 *     button when the job reaches a terminal state.
 */

function appendImageGenLog(message, tone = "") {
  if (!imageGenLog) return;
  imageGenLog.classList.remove("hidden");
  const line = document.createElement("div");
  line.textContent = message;
  if (tone === "error") line.classList.add("text-error");
  if (tone === "success") line.classList.add("text-green-600");
  imageGenLog.appendChild(line);
  imageGenLog.scrollTop = imageGenLog.scrollHeight;
}

async function refreshImageGenResult(jobId) {
  try {
    const row = await fetchJSON(`/api/scheduler/generate-image/${jobId}`);
    if (row.gen_prompt) {
      imageGenOutput.classList.remove("hidden");
      imageGenPrompt.textContent = row.gen_prompt;
    }
    if (row.file_path) {
      imageGenOutput.classList.remove("hidden");
      imageGenFile.textContent = row.file_path;
    }
    if (row.error) {
      appendImageGenLog(row.error, "error");
    }
  } catch (err) {
    appendImageGenLog(`Could not load job result: ${err.message}`, "error");
  }
}

function startImageGenStream(jobId) {
  imageGenStatus.textContent = "Running";
  imageGenLog.innerHTML = "";
  imageGenLog.classList.remove("hidden");
  imageGenOutput.classList.add("hidden");
  imageGenPrompt.textContent = "";
  imageGenFile.textContent = "";

  const stream = window.gtss.initSSE(
    `/api/scheduler/stream/${jobId}`,
    async (data) => {
      if (!data) return;
      if (data.type === "connected") {
        appendImageGenLog("Connected to job stream.");
        return;
      }
      if (data.jobId && String(data.jobId) !== String(jobId)) return;

      appendImageGenLog(data.message || data.type);
      if (data.genPrompt) {
        imageGenOutput.classList.remove("hidden");
        imageGenPrompt.textContent = data.genPrompt;
      }
      if (data.filePath) {
        imageGenOutput.classList.remove("hidden");
        imageGenFile.textContent = data.filePath;
      }

      if (data.type === "download_complete") {
        imageGenStatus.textContent = "Complete";
        appendImageGenLog("Download complete.", "success");
        await refreshImageGenResult(jobId);
        stream.close();
        imageGenStartBtn.disabled = false;
        imageGenStartBtn.innerHTML =
          '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
      }

      if (data.type === "error") {
        imageGenStatus.textContent = "Failed";
        appendImageGenLog(data.message || "Image generation failed.", "error");
        await refreshImageGenResult(jobId);
        stream.close();
        imageGenStartBtn.disabled = false;
        imageGenStartBtn.innerHTML =
          '<span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate Image';
      }
    },
  );
}

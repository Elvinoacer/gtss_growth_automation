/**
 * contentPipeline/pickAssetOrGenerateImage.js
 *
 * Stage 1 of the content pipeline: pick the media asset(s) to attach to
 * the post. Two branches, dispatched by the `content_asset_source`
 * setting:
 *
 *   - 'library': use the unified rotation queue
 *     (pickNextAssetOrGroup) to pick either an asset group OR an
 *     ungrouped asset — both kinds are treated as equal citizens in a
 *     single queue ordered by times_used ASC then last_used_at ASC, so
 *     every asset eventually gets posted. Previously this called
 *     pickNextAssetGroup() FIRST and only fell back to pickNextAsset()
 *     when NO groups existed, which starved every ungrouped asset.
 *
 *     For groups: posts.media_paths gets every asset's file_path
 *     (absolute, set by multer at upload time — NOT the file_url
 *     relative URL, which previously caused path-resolution ambiguity
 *     on Linux where "/uploads/..." is path.isAbsolute()===true).
 *     For single assets: posts.media_path gets the file_path directly.
 *
 *     After picking, marks the asset/group as used (bumps times_used +
 *     last_used_at) so the next run picks a different one. Marking
 *     happens at PUBLISH time (not pick time) in runContentPipeline, so
 *     a run that fails before publishing doesn't bump the rotation
 *     counter.
 *
 *   - 'ai' (default): generate a fresh image via runImageGenJob (which
 *     drives Gemini Web under the hood). Wrapped in withRetry so a
 *     transient Gemini rate-limit retries instead of failing the run.
 *     The generated file is copied into UPLOADS_DIR so the publisher
 *     can serve it via /uploads/<name>. Checkpoint-aware: if the
 *     lifecycleExecId already has a 'completed' image_gen checkpoint
 *     (e.g. after a retry-stage call), the AI gen is skipped entirely.
 *
 * Returns: { mediaRelPath, mediaRelPaths, selectedAsset, selectedGroup }
 *  - mediaRelPath: the primary media path (string) — always set
 *  - mediaRelPaths: array when a group / multi-image; null otherwise
 *  - selectedAsset / selectedGroup: the picked asset or group (used by
 *    the publisher to bump the rotation counter after publish)
 *
 * Extracted from runContentPipelineNow so the main orchestrator stays
 * under the 500-line file-size limit.
 */

const fs = require("fs");
const path = require("path");
const { runImageGenJob } = require("../../services/imageGenService");
const {
  pickNextAssetOrGroup,
} = require("../../services/assetRotationService");
const { withRetry } = require("../../utils/retryHelper");
const pipelineLogger = require("../../services/pipelineLogger");
const checkpointService = require("../../services/pipelineCheckpoint");
const { UPLOADS_DIR, getSetting } = require("./state");

/**
 * Pick an asset from the library OR generate an AI image.
 *
 * @param {Object} ctx
 * @param {string} ctx.topic
 * @param {string} ctx.style
 * @param {string[]} ctx.platforms
 * @param {string} ctx.jobId
 * @param {Function} ctx.emit
 * @param {AbortSignal} ctx.signal
 * @param {string|null} ctx.lifecycleExecId
 * @param {Function} ctx.updateLifecycle
 * @param {Function} ctx.checkAbort
 * @returns {Promise<{mediaRelPath: string, mediaRelPaths: string[]|null, selectedAsset: Object|null, selectedGroup: Object|null}>}
 */
async function pickAssetOrGenerateImage({
  topic,
  style,
  platforms,
  jobId,
  emit,
  signal,
  lifecycleExecId,
  updateLifecycle,
  checkAbort,
}) {
  let mediaRelPath;
  let mediaRelPaths = null; // array when group / multi-image, null otherwise
  let selectedAsset = null;
  let selectedGroup = null;
  const assetSource = getSetting("content_asset_source", "ai");
  if (assetSource === "library") {
    const mediaType = getSetting("content_library_media_type", "image");
    // ── Unified rotation queue (groups AND ungrouped assets) ─────────
    // Previously this called pickNextAssetGroup() FIRST and only fell
    // back to pickNextAsset() when NO groups existed. That starved
    // every ungrouped asset — they were never picked as long as any
    // group existed. The user explicitly asked for both kinds to be
    // used: "those [ungrouped] ones that have not been grouped
    // together, I need you to be using them as they are whenever
    // it's necessary." pickNextAssetOrGroup() treats both kinds as
    // equal citizens in a single queue, ordered by times_used ASC
    // then last_used_at ASC, so every asset eventually gets posted.
    const unit = pickNextAssetOrGroup({ mediaType });
    if (!unit || !unit.assets || unit.assets.length === 0) {
      throw new Error("Asset library is empty");
    }
    if (unit.kind === "group") {
      selectedGroup = unit.group;
      // ── Use file_path (absolute) NOT file_url (relative) ─────────
      // The asset_library row stores BOTH:
      //   file_url  = "/uploads/library/foo.jpg"  (HTTP path)
      //   file_path = "<serverRoot>/public/uploads/library/foo.jpg"
      //                (absolute filesystem path, set by multer)
      // Previously we stored file_url in posts.media_path, then
      // resolveMediaFilePath() had to guess the absolute path. On
      // Linux, "/uploads/..." is path.isAbsolute()===true, so the
      // first candidate (the literal /uploads/... at filesystem
      // root) was tried first and silently failed. If the second
      // candidate (<serverRoot>/public/...) also missed (e.g.,
      // server cwd mismatch, profile/dir layout change), the
      // resolution returned null and the post went out as
      // TEXT-ONLY — exactly the regression the user reported:
      // "the media is not being attached ... it goes ahead and
      //  just posts the caption and [ignores] my library of
      //  assets." Storing file_path (absolute) directly
      // eliminates the resolution ambiguity entirely.
      mediaRelPaths = unit.assets.map((a) => a.file_path || a.file_url);
      mediaRelPath = mediaRelPaths[0];
      emit({
        stage: "asset_library",
        message: `Selected asset group: ${selectedGroup.name} (${unit.assets.length} asset(s), type: ${selectedGroup.post_type})`,
      });
      updateLifecycle(
        "asset_library",
        `Selected asset group: ${selectedGroup.name} (${unit.assets.length} asset(s))`,
        25,
        1,
      );
    } else {
      selectedAsset = unit.asset;
      mediaRelPath = selectedAsset.file_path || selectedAsset.file_url;
      mediaRelPaths = null;
      emit({
        stage: "asset_library",
        message: `Selected library asset: ${selectedAsset.name}`,
      });
      updateLifecycle("asset_library", `Selected library asset: ${selectedAsset.name}`, 25, 1);
    }
  } else {
    // ── Stage 1: Generate image ──────────────────────────────────────
    checkAbort();
    updateLifecycle("image_gen", `Generating image for topic: "${topic}"…`, 5, 0);
    emit({
      stage: "image_gen",
      message: `Generating image for topic: "${topic}"...`,
    });

    // Skip if checkpoint already exists for image_gen
    if (lifecycleExecId && checkpointService.isStageComplete(lifecycleExecId, "image_gen")) {
      emit({ stage: "image_gen", message: "Image generation skipped: checkpoint already complete" });
      updateLifecycle("image_gen", "Image generation skipped (checkpoint)", 25, 1);
    } else {
      const { filePath, fileName } = await withRetry(
        () =>
          runImageGenJob({
            jobId,
            topic,
            style,
            platform: platforms[0] || "instagram",
          }),
        {
          signal,
          label: "content:image_gen",
          entityType: "pipeline",
          entityId: jobId,
          onRetry: (attempt, err) => {
            emit({
              stage: "image_gen",
              type: "retry",
              level: "retry",
              message: `Image generation retry ${attempt}: ${err.message}`,
            });
            if (lifecycleExecId) {
              pipelineLogger.log({
                pipelineId: "content",
                executionId: lifecycleExecId,
                level: "retry",
                stage: "image_gen",
                message: `Image generation retry ${attempt}: ${err.message}`,
                retryAttempt: attempt,
              });
            }
          },
        },
      );

      emit({ stage: "image_gen", message: `Image saved: ${fileName}` });

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const destName = `auto-${Date.now()}-${fileName}`;
      const destPath = path.join(UPLOADS_DIR, destName);
      await fs.promises.copyFile(filePath, destPath);
      mediaRelPath = `/uploads/${destName}`;

      emit({
        stage: "image_gen",
        message: `Image copied to uploads: ${destName}`,
      });

      if (lifecycleExecId) {
        checkpointService.saveCheckpoint({
          executionId: lifecycleExecId,
          pipelineId: "content",
          stage: "image_gen",
          status: "completed",
          payload: { filePath: mediaRelPath, fileName: destName },
        });
      }
      updateLifecycle("image_gen", `Image generated: ${destName}`, 25, 1);
    }
  }

  return { mediaRelPath, mediaRelPaths, selectedAsset, selectedGroup };
}

module.exports = { pickAssetOrGenerateImage };

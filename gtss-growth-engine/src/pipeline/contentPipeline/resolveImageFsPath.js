/**
 * contentPipeline/resolveImageFsPath.js
 *
 * Resolve a posts.media_path value to an on-disk absolute filesystem
 * path for image-aware captioning.
 *
 * The asset library stores the absolute `file_path` (set by multer at
 * upload time) directly in posts.media_path, so when the path is
 * absolute AND exists, we use it directly. For AI-generated images
 * (which still use the URL form `/uploads/<name>`), we resolve the URL
 * against the writable UPLOADS_DIR first (desktop app), then fall back
 * to the bundled public/ dir (dev mode).
 *
 * Returns null when:
 *   - the media path isn't an image (e.g. video, missing extension)
 *   - the file doesn't exist on disk (caller falls back to text-only
 *     captioning)
 *
 * Extracted from runContentPipelineNow so the main orchestrator stays
 * under the 500-line file-size limit.
 */

const fs = require("fs");
const path = require("path");
const { UPLOADS_DIR } = require("./state");

/**
 * Resolve a media path (URL or absolute) to an on-disk image path.
 *
 * @param {string|null|undefined} mediaRelPath
 * @returns {string|null} absolute FS path if the file exists, else null
 */
function resolveImageFsPath(mediaRelPath) {
  let imageFsPath = null;
  try {
    if (mediaRelPath && /\.(jpe?g|png|gif|webp)$/i.test(mediaRelPath)) {
      if (path.isAbsolute(mediaRelPath) && fs.existsSync(mediaRelPath)) {
        imageFsPath = mediaRelPath;
      } else {
        // Try the WRITABLE UPLOADS_DIR first (desktop app), then
        // the bundled public/ dir (dev mode).
        const candidates = [];
        if (mediaRelPath.startsWith("/")) {
          candidates.push(path.resolve(UPLOADS_DIR, `.${mediaRelPath}`));
          candidates.push(path.resolve(UPLOADS_DIR, mediaRelPath));
          candidates.push(path.resolve(__dirname, "../../../public", mediaRelPath.replace(/^\//, "")));
        } else {
          candidates.push(path.resolve(UPLOADS_DIR, mediaRelPath));
          candidates.push(path.resolve(__dirname, "../../../public", mediaRelPath));
        }
        imageFsPath = candidates.find((c) => fs.existsSync(c)) || null;
      }
    }
  } catch (_) { /* fall back to text-only */ }
  return imageFsPath;
}

module.exports = { resolveImageFsPath };

/**
 * Scheduler Routes — Media Upload
 *
 * Express handler for uploading a single media attachment (image or video)
 * to the scheduler's uploads directory. Returns both a web-accessible
 * preview URL and an absolute filesystem path for Playwright:
 *   POST /api/scheduler/upload-media  — multipart/form-data `media` field
 *
 * Cross-file dependencies: ./shared (upload — the configured multer instance).
 *
 * Extracted from the original routes/scheduler.js for maintainability.
 */

const { upload } = require("./shared");

/**
 * Register the media-upload route on the given router.
 *
 * @param {import('express').Router} router
 */
function registerUploadRoutes(router) {
  // ---------------------------------------------------------------------------
  // API: Media Upload
  // ---------------------------------------------------------------------------

  router.post("/api/scheduler/upload-media", (req, res) => {
    upload.single("media")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      res.json({
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`, // web-accessible preview URL
        filePath: req.file.path, // absolute FS path for Playwright
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    });
  });
}

module.exports = { registerUploadRoutes };
